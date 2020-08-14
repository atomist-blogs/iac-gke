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

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

/** Arguments for [[resourcesFromSpecs]]. */
export interface ResourcesFromSpecsArgs {
	/**
	 * Options to use when creating the resources. The Kubernetes
	 * provider will be automatically set as the provider.
	 */
	options: { provider: k8s.Provider } & pulumi.CustomResourceOptions;
	/** Kubernetes specs to create resources for. */
	specs: any[];
	/**
	 * Function that each spec is sent to before creating the
	 * resource. It allows you to modify the spec, e.g., add a
	 * workload identity annotation, before it is created. This
	 * function can return `undefined` and the provided resource will
	 * not be created.
	 */
	transform?: (i: any) => any;
}

/**
 * Create resources using the Kubernetes provider for all the specs.
 * The specs are sorted such that the custom resource definitions and
 * namespaces are created first and the remaining resources are
 * created depending on those.
 */
export async function resourcesFromSpecs(
	args: ResourcesFromSpecsArgs,
): Promise<pulumi.Resource[]> {
	const transform = args.transform || ((i: any) => i);
	const first = args.specs
		.filter(
			s =>
				s?.kind === "CustomResourceDefinition" ||
				s?.kind === "Namespace",
		)
		.map(transform)
		.map(s => createSpecResource(s, args.options))
		.filter(r => !!r) as pulumi.Resource[];
	const opts = { ...args.options };
	if (first.length > 0) {
		opts.dependsOn = first;
	}
	const rest = args.specs
		.filter(
			s =>
				s?.kind !== "CustomResourceDefinition" &&
				s?.kind !== "Namespace",
		)
		.map(transform)
		.map(s => createSpecResource(s, opts))
		.filter(r => !!r) as pulumi.Resource[];
	return [...first, ...rest];
}

/**
 * Create an arbitrary Kubernetes resource from the provided spec.
 *
 * Not all available resource kinds are supported.  Feel free to add
 * them as you need them.
 */
function createSpecResource(
	spec: any,
	opts: pulumi.CustomResourceOptions,
): pulumi.Resource | undefined {
	const resource = specResourceName(spec);
	if (!resource) {
		return undefined;
	}
	if (spec.kind === "ConfigMap") {
		return new k8s.core.v1.ConfigMap(resource, spec, opts);
	} else if (spec.kind === "Namespace") {
		return new k8s.core.v1.Namespace(resource, spec, opts);
	} else if (spec.kind === "Secret") {
		return new k8s.core.v1.Secret(resource, spec, opts);
	} else if (spec.kind === "Service") {
		return new k8s.core.v1.Service(resource, spec, opts);
	} else if (spec.kind === "ServiceAccount") {
		return new k8s.core.v1.ServiceAccount(resource, spec, opts);
	} else if (spec.kind === "DaemonSet") {
		return new k8s.apps.v1.DaemonSet(resource, spec, opts);
	} else if (spec.kind === "Deployment") {
		return new k8s.apps.v1.Deployment(resource, spec, opts);
	} else if (spec.kind === "StatefulSet") {
		return new k8s.apps.v1.StatefulSet(resource, spec, opts);
	} else if (spec.kind === "Job") {
		return new k8s.batch.v1.Job(resource, spec, opts);
	} else if (spec.kind === "CronJob") {
		return new k8s.batch.v1beta1.CronJob(resource, spec, opts);
	} else if (spec.kind === "PodDisruptionBudget") {
		return new k8s.policy.v1beta1.PodDisruptionBudget(resource, spec, opts);
	} else if (spec.kind === "PodSecurityPolicy") {
		return new k8s.policy.v1beta1.PodSecurityPolicy(resource, spec, opts);
	} else if (spec.kind === "NetworkPolicy") {
		return new k8s.networking.v1.NetworkPolicy(resource, spec, opts);
	} else if (spec.kind === "Ingress") {
		return new k8s.networking.v1beta1.Ingress(resource, spec, opts);
	} else if (spec.kind === "ClusterRole") {
		return new k8s.rbac.v1.ClusterRole(resource, spec, opts);
	} else if (spec.kind === "ClusterRoleBinding") {
		return new k8s.rbac.v1.ClusterRoleBinding(resource, spec, opts);
	} else if (spec.kind === "Role") {
		return new k8s.rbac.v1.Role(resource, spec, opts);
	} else if (spec.kind === "RoleBinding") {
		return new k8s.rbac.v1.RoleBinding(resource, spec, opts);
	} else if (spec.kind === "MutatingWebhookConfiguration") {
		if (spec.apiVersion === "admissionregistration.k8s.io/v1beta1") {
			return new k8s.admissionregistration.v1beta1.MutatingWebhookConfiguration(
				resource,
				spec,
				opts,
			);
		} else {
			return new k8s.admissionregistration.v1.MutatingWebhookConfiguration(
				resource,
				spec,
				opts,
			);
		}
	} else if (spec.kind === "ValidatingWebhookConfiguration") {
		if (spec.apiVersion === "admissionregistration.k8s.io/v1beta1") {
			return new k8s.admissionregistration.v1beta1.ValidatingWebhookConfiguration(
				resource,
				spec,
				opts,
			);
		} else {
			return new k8s.admissionregistration.v1.ValidatingWebhookConfiguration(
				resource,
				spec,
				opts,
			);
		}
	} else if (spec.kind === "CustomResourceDefinition") {
		if (spec.apiVersion === "apiextensions.k8s.io/v1beta1") {
			return new k8s.apiextensions.v1beta1.CustomResourceDefinition(
				resource,
				spec,
				opts,
			);
		} else {
			return new k8s.apiextensions.v1.CustomResourceDefinition(
				resource,
				spec,
				opts,
			);
		}
	} else {
		return new k8s.apiextensions.CustomResource(resource, spec, opts);
	}
}

interface MinimalK8sSpec {
	kind: string;
	metadata: {
		name: string;
		namespace?: string;
	};
}

/** Generate resource name for spec. */
function specResourceName(spec: MinimalK8sSpec): string | undefined {
	if (!spec?.kind || !spec?.metadata?.name) {
		return undefined;
	}
	const kind = spec.kind.toLowerCase();
	const parts = ["k8s", kind];
	if (kind !== "namespace" && spec.metadata?.namespace) {
		parts.push(spec.metadata.namespace);
	}
	parts.push(spec.metadata.name);
	return parts.join("/");
}
