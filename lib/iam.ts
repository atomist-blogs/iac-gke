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
import * as pulumi from "@pulumi/pulumi";

/**
 * Remove "roles/" from IAM role identifier, replace "." with "-", and
 * lowercase the string, creating a string safe to use in a resource
 * name.
 */
export function simpleRoleName(role: string): string {
	return role
		.replace(/^roles\//, "")
		.replace(/\./g, "-")
		.toLowerCase();
}

/** GKE workload identity configuration. */
export interface WorkloadIdentityConfiguration {
	/** GCP project ID to create resources */
	projectId: pulumi.Output<string>;
	/** GCP IAM roles to bind to service account */
	projectRoles: string[];
	/** Kubernetes service account name */
	workload: string;
	/** Kubernetes service account namespace */
	workloadNamespace: string;
	/**
	 * Options to use when creating the resources. The Kubernetes
	 * provider will be automatically set as the provider.
	 */
	options?: pulumi.CustomResourceOptions;
	/**
	 * GCP project ID of workload. If not provided, [[projectId]] is
	 * used.
	 */
	workloadProject?: pulumi.Output<string>;
}

/**
 * Create a GCP service account for workload identity, bind the
 * provided roles to the GCP service account, and then link the GCP
 * service account to the Kubernetes workload, i.e., service account.
 */
export function workloadIdentity(
	wi: WorkloadIdentityConfiguration,
): gcp.serviceAccount.Account {
	const workloadProject = wi.workloadProject || wi.projectId;
	const wiServiceAccountName = `sa-wi-${wi.workload}`.substring(0, 30);
	const wiServiceAccount = new gcp.serviceAccount.Account(
		wiServiceAccountName,
		{
			accountId: wiServiceAccountName,
			description: `GKE Workload Identity Service Account for ${wi.workloadNamespace}/${wi.workload}`,
			displayName: `${wi.workload} Workload Identity Service Account`,
			project: workloadProject,
		},
		wi.options,
	);
	for (const role of wi.projectRoles) {
		new gcp.projects.IAMMember(
			`sa-wi-${wi.workload}-${simpleRoleName(role)}-member`,
			{
				member: pulumi.concat(
					"serviceAccount:",
					wiServiceAccount.email,
				),
				project: wi.projectId,
				role,
			},
			wi.options,
		);
	}
	new gcp.serviceAccount.IAMPolicy(
		`sa-wi-${wi.workload}-policy`,
		{
			policyData: workloadProject.apply(wpId =>
				JSON.stringify({
					bindings: [
						{
							members: [
								`serviceAccount:${wpId}.svc.id.goog[${wi.workloadNamespace}/${wi.workload}]`,
							],
							role: "roles/iam.workloadIdentityUser",
						},
					],
				}),
			),
			serviceAccountId: wiServiceAccount.id,
		},
		wi.options,
	);
	return wiServiceAccount;
}
