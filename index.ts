/*
 * Copyright © 2020 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs-extra";
import * as yaml from "js-yaml";
import fetch from "node-fetch";
import * as path from "path";
import * as publicip from "public-ip";
import {
	billingAccount,
	channel,
	dnsName,
	env,
	gcpProject,
	gcpUser,
	location,
	machineType,
	masterAuthorizedNetworkCidrBlocks,
	maxNodeCount,
	minNodeCount,
	purpose,
	region,
	zones,
} from "./config";
import { workloadIdentity, simpleRoleName } from "./lib/iam";
import { resourcesFromSpecs } from "./lib/k8s";

interface Resources {
	clusterProject: gcp.organizations.Project;
	dnsProject: gcp.organizations.Project;
	kmsProject: gcp.organizations.Project;
	network: gcp.compute.Network;
	subnetwork: gcp.compute.Subnetwork;
	router: gcp.compute.Router;
	nat: gcp.compute.RouterNat;
	nodeServiceAccount: gcp.serviceAccount.Account;
	kmsKey: gcp.kms.CryptoKey;
	cluster: gcp.container.Cluster;
	nodePool: gcp.container.NodePool;
	dnsZone: gcp.dns.ManagedZone;
	workloadIdentityServiceAccounts: Record<string, gcp.serviceAccount.Account>;
}

async function main(): Promise<Resources> {
	const user = gcpUser.replace(/@.*/, "");
	const labels = { env, purpose, user };

	const clusterProject = new gcp.organizations.Project(gcpProject, {
		autoCreateNetwork: false,
		billingAccount,
		labels,
		name: "GKE Infrastructure",
		projectId: gcpProject,
	});
	const containerService = new gcp.projects.Service(
		`${gcpProject}-container-service`,
		{
			project: clusterProject.projectId,
			service: "container.googleapis.com",
		},
	);

	const network = new gcp.compute.Network(`net-${purpose}`, {
		autoCreateSubnetworks: false,
		deleteDefaultRoutesOnCreate: false,
		description: `${user} Kubernetes ${env} cluster network`,
		project: clusterProject.projectId,
		routingMode: "REGIONAL",
	});

	const clusterName = `gke-${purpose}`;
	const oauthScopes = [
		"https://www.googleapis.com/auth/cloud-platform",
		"https://www.googleapis.com/auth/userinfo.email",
	];

	const podRangeName = `${clusterName}-pods`;
	const serviceRangeName = `${clusterName}-services`;
	const subnetwork = new gcp.compute.Subnetwork(`sub-${clusterName}`, {
		description: `${user} Kubernetes ${env} cluster subnetwork`,
		ipCidrRange: "10.0.0.0/22",
		network: network.selfLink,
		privateIpGoogleAccess: true,
		project: clusterProject.projectId,
		purpose: "PRIVATE",
		region,
		secondaryIpRanges: [
			{ ipCidrRange: "10.0.16.0/20", rangeName: serviceRangeName },
			{ ipCidrRange: "10.12.0.0/14", rangeName: podRangeName },
		],
	});

	const router = new gcp.compute.Router("nat-router", {
		description: "NAT router for private GKE cluster",
		network: network.selfLink,
		project: clusterProject.projectId,
		region,
	});
	const nat = new gcp.compute.RouterNat("nat-config", {
		natIpAllocateOption: "AUTO_ONLY",
		project: clusterProject.projectId,
		region,
		router: router.name,
		sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
		subnetworks: [
			{
				name: subnetwork.selfLink,
				sourceIpRangesToNats: ["ALL_IP_RANGES"],
			},
		],
	});

	const nodeServiceAccountName = `${clusterName}-node-sa`;
	const nodeServiceAccount = new gcp.serviceAccount.Account(
		nodeServiceAccountName,
		{
			accountId: nodeServiceAccountName,
			description: "GKE node pool service account",
			displayName: `${user} ${env} node service account`,
			project: clusterProject.projectId,
		},
	);
	const nodeRoles = [
		"roles/logging.logWriter",
		"roles/monitoring.metricWriter",
		"roles/monitoring.viewer",
	];
	for (const role of nodeRoles) {
		new gcp.projects.IAMMember(
			`${gcpProject}-${simpleRoleName(role)}-member`,
			{
				member: pulumi.concat(
					"serviceAccount:",
					nodeServiceAccount.email,
				),
				project: clusterProject.projectId,
				role,
			},
		);
	}

	const kmsProjectName = `${purpose}-kms`;
	const kmsProject = new gcp.organizations.Project(kmsProjectName, {
		autoCreateNetwork: false,
		billingAccount,
		labels,
		name: "Kubernetes KMS Infrastructure",
		projectId: kmsProjectName,
	});
	const kmsService = new gcp.projects.Service(
		`${kmsProjectName}-cloudkms-service`,
		{
			project: kmsProject.projectId,
			service: "cloudkms.googleapis.com",
		},
	);
	const kmsKeyRing = new gcp.kms.KeyRing(
		"gke-key-ring",
		{
			location: region,
			project: kmsProject.projectId,
		},
		{ dependsOn: [kmsService] },
	);
	const kmsKey = new gcp.kms.CryptoKey("gke-key", {
		keyRing: kmsKeyRing.id,
		labels,
		purpose: "ENCRYPT_DECRYPT",
		rotationPeriod: "7776000s", // 90 days
		versionTemplate: {
			algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION",
			protectionLevel: "SOFTWARE",
		},
	});
	new gcp.kms.CryptoKeyIAMPolicy(
		"gke-key-iam-policy",
		{
			cryptoKeyId: kmsKey.id,
			policyData: clusterProject.number.apply(n =>
				JSON.stringify({
					bindings: [
						{
							members: [
								`serviceAccount:service-${n}@container-engine-robot.iam.gserviceaccount.com`,
							],
							role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
						},
					],
				}),
			),
		},
		{ dependsOn: [containerService, kmsService] },
	);

	const dnsProjectName = `${purpose}-dns`;
	const dnsProject = new gcp.organizations.Project(dnsProjectName, {
		autoCreateNetwork: false,
		billingAccount,
		labels,
		name: "Kubernetes DNS Infrastructure",
		projectId: dnsProjectName,
	});
	const dnsService = new gcp.projects.Service(
		`${dnsProjectName}-dns-service`,
		{
			project: dnsProject.projectId,
			service: "dns.googleapis.com",
		},
	);
	const dnsZone = new gcp.dns.ManagedZone(
		`${dnsName.replace(/\.$/, "").replace(/\./g, "-")}-zone`,
		{
			description: "Kubernetes DNS zone",
			dnsName,
			dnssecConfig: {
				state: "on",
			},
			labels,
			project: dnsProject.projectId,
			visibility: "public",
		},
		{ dependsOn: [dnsService] },
	);

	const masterIpv4CidrBlock = "172.19.13.32/28";
	// https://kubernetes.github.io/ingress-nginx/deploy/#gce-gke
	const nginxIngressFirewall = new gcp.compute.Firewall(
		"fw-master-to-ingress-nginx",
		{
			allows: [
				{
					protocol: "tcp",
					ports: ["8443"],
				},
			],
			description:
				"Ingress from k8s master to ingress-nginx validating webhook",
			direction: "INGRESS",
			disabled: false,
			network: network.id,
			priority: 1000,
			sourceRanges: [masterIpv4CidrBlock],
			targetServiceAccounts: [nodeServiceAccount.email],
		},
	);
	const nodeLocations =
		location === region ? zones : zones?.filter(z => z !== location);
	const cluster = new gcp.container.Cluster(
		clusterName,
		{
			addonsConfig: {
				cloudrunConfig: { disabled: true },
				dnsCacheConfig: { enabled: true },
				horizontalPodAutoscaling: { disabled: false },
				httpLoadBalancing: { disabled: true },
				networkPolicyConfig: { disabled: false },
			},
			clusterAutoscaling: {
				enabled: false,
			},
			databaseEncryption: {
				keyName: kmsKey.id,
				state: "ENCRYPTED",
			},
			description: `${user} Kubernetes ${env} cluster`,
			enableBinaryAuthorization: false,
			enableIntranodeVisibility: false,
			enableKubernetesAlpha: false,
			enableLegacyAbac: false,
			enableShieldedNodes: true,
			enableTpu: false,
			initialNodeCount: location === region ? 1 : 3,
			ipAllocationPolicy: {
				clusterSecondaryRangeName: podRangeName,
				servicesSecondaryRangeName: serviceRangeName,
			},
			location,
			loggingService: "logging.googleapis.com/kubernetes",
			maintenancePolicy: {
				recurringWindow: {
					endTime: "2000-01-02T05:00:00Z",
					recurrence: "FREQ=WEEKLY;BYDAY=SA,SU",
					startTime: "2000-01-01T20:00:00Z",
				},
			},
			masterAuth: {
				clientCertificateConfig: {
					issueClientCertificate: false,
				},
			},
			masterAuthorizedNetworksConfig: {
				cidrBlocks: masterAuthorizedNetworkCidrBlocks || [
					{
						displayName: user,
						cidrBlock: (await publicip.v4()) + "/32",
					},
				],
			},
			monitoringService: "monitoring.googleapis.com/kubernetes",
			network: network.selfLink,
			networkPolicy: {
				enabled: true,
				provider: "CALICO",
			},
			nodeLocations,
			podSecurityPolicyConfig: {
				enabled: false,
			},
			privateClusterConfig: {
				enablePrivateEndpoint: false,
				enablePrivateNodes: true,
				masterIpv4CidrBlock,
			},
			project: clusterProject.projectId,
			releaseChannel: {
				channel,
			},
			removeDefaultNodePool: true,
			resourceLabels: labels,
			subnetwork: subnetwork.selfLink,
			workloadIdentityConfig: {
				identityNamespace: pulumi.concat(
					clusterProject.projectId,
					".svc.id.goog",
				),
			},
		},
		{ customTimeouts: { create: "60m", delete: "120m" } },
	);

	const nodePool = new gcp.container.NodePool(
		"wi-pool",
		{
			autoscaling: {
				maxNodeCount,
				minNodeCount,
			},
			cluster: cluster.name,
			initialNodeCount: minNodeCount,
			location,
			management: {
				autoRepair: true,
				autoUpgrade: true,
			},
			maxPodsPerNode: 64,
			nodeConfig: {
				diskSizeGb: 100,
				diskType: "pd-standard",
				guestAccelerators: [],
				imageType: "COS_CONTAINERD",
				labels,
				localSsdCount: 0,
				machineType,
				metadata: {
					"disable-legacy-endpoints": "true",
				},
				oauthScopes,
				preemptible: false,
				serviceAccount: nodeServiceAccount.email,
				shieldedInstanceConfig: {
					enableIntegrityMonitoring: true,
					enableSecureBoot: true,
				},
				tags: ["kubernetes-node", env, purpose, user],
				taints: [],
				workloadMetadataConfig: {
					nodeMetadata: "GKE_METADATA_SERVER",
				},
			},
			nodeLocations,
			project: clusterProject.projectId,
			upgradeSettings: {
				maxSurge: 1,
				maxUnavailable: 1,
			},
		},
		{ customTimeouts: { create: "60m", delete: "120m" } },
	);

	const ingressIpAddress = new gcp.compute.Address(
		"nginx-ingress-svc-ip-address",
		{
			addressType: "EXTERNAL",
			description: "nginx-ingress service load balancer IP address",
			labels,
			networkTier: "PREMIUM",
			project: clusterProject.projectId,
			region,
		},
	);

	const workloadIdentities = [
		{
			projectRoles: ["roles/dns.admin"],
			workload: "cert-manager",
			workloadNamespace: "cert-manager",
		},
		{
			projectRoles: ["roles/dns.admin"],
			workload: "external-dns",
			workloadNamespace: "external-dns",
		},
	];
	const workloadIdentityServiceAccounts: Record<
		string,
		gcp.serviceAccount.Account
	> = {};
	for (const wi of workloadIdentities) {
		workloadIdentityServiceAccounts[wi.workload] = workloadIdentity({
			options: { dependsOn: [cluster] },
			projectId: dnsProject.projectId,
			workloadProject: clusterProject.projectId,
			...wi,
		});
	}

	const k8sProvider = new k8s.Provider("k8s-provider", {
		kubeconfig: pulumi
			.all([
				cluster.name,
				cluster.endpoint,
				cluster.masterAuth,
				cluster.location,
				cluster.project,
			])
			.apply(([name, endpoint, auth, location, projectId]) => {
				const context = `${projectId}_${location}_${name}`;
				return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${auth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
`;
			}),
	});
	const k8sClusterAdminRole = new k8s.rbac.v1.ClusterRoleBinding(
		"atomist-admin-cluster-role-binding",
		{
			apiVersion: "rbac.authorization.k8s.io/v1",
			kind: "ClusterRoleBinding",
			roleRef: {
				apiGroup: "rbac.authorization.k8s.io",
				kind: "ClusterRole",
				name: "cluster-admin",
			},
			subjects: [
				{
					apiGroup: "rbac.authorization.k8s.io",
					kind: "User",
					name: gcpUser,
				},
			],
		},
		{
			provider: k8sProvider,
		},
	);

	const specUrls = [
		"https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v0.34.1/deploy/static/provider/cloud/deploy.yaml",
		"https://github.com/jetstack/cert-manager/releases/download/v0.16.1/cert-manager.yaml",
	];
	const specsYamls: string[] = [];
	for (const url of specUrls) {
		specsYamls.push(await (await fetch(url)).text());
	}
	specsYamls.push(
		await fs.readFile(path.join("k8s", "external-dns.yaml"), "utf8"),
	);
	const specs: any[] = [];
	for (const specsYaml of specsYamls) {
		specs.push(...yaml.safeLoadAll(specsYaml));
	}
	await resourcesFromSpecs({
		options: {
			dependsOn: [k8sClusterAdminRole, nginxIngressFirewall],
			provider: k8sProvider,
		},
		specs,
		transform: s => {
			if (s?.kind === "ServiceAccount" && s.metadata?.name) {
				if (
					s.metadata.name === "cert-manager" ||
					s.metadata.name === "external-dns"
				) {
					if (!s.metadata.annotations) {
						s.metadata.annotations = {};
					}
					s.metadata.annotations["iam.gke.io/gcp-service-account"] =
						workloadIdentityServiceAccounts[s.metadata.name].email;
				}
			} else if (
				s?.kind === "Service" &&
				s?.metadata?.name === "ingress-nginx-controller" &&
				s?.metadata?.namespace === "ingress-nginx"
			) {
				s.spec.loadBalancerIP = ingressIpAddress.address;
			} else if (
				s?.kind === "Deployment" &&
				s?.metadata?.name === "external-dns" &&
				s?.metadata?.namespace === "external-dns"
			) {
				s.spec.template.spec.containers[0].args = s.spec.template.spec.containers[0].args.map(
					(a: string) => {
						if (a.startsWith("--domain-filter=")) {
							return a.replace(
								/=.*/,
								`=${dnsName.replace(/\.$/, "")}`,
							);
						} else if (a.startsWith("--google-project=")) {
							return a.replace(/=.*/, `=${dnsProjectName}`);
						} else if (a.startsWith("--txt-owner-id=")) {
							return a.replace(/=.*/, `=${purpose}`);
						} else {
							return a;
						}
					},
				);
			}
			return s;
		},
	});

	return {
		clusterProject,
		dnsProject,
		kmsProject,
		network,
		subnetwork,
		router,
		nat,
		nodeServiceAccount,
		kmsKey,
		cluster,
		nodePool,
		dnsZone,
		workloadIdentityServiceAccounts,
	};
}

const resources = main();
resources.catch(err => console.error(err.message));
export const project = resources.then(r => r.clusterProject.projectId);
export const nodeServiceAccount = resources.then(
	r => r.nodeServiceAccount.email,
);
export const cluster = resources.then(r => r.cluster.name);
export const dnsNameservers = resources.then(r => r.dnsZone.nameServers);
export const workloadIdentityServiceAccounts = resources
	.then(r => r.workloadIdentityServiceAccounts)
	.then(wisa => Object.keys(wisa).map(wi => wisa[wi].email));
