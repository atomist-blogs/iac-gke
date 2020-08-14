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
import * as gcp from "@pulumi/gcp";
import { execFileSync } from "child_process";

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config("gcp");

/** GCP project for GKE cluster */
export const gcpProject = gcpConfig.require("project");

/** Project billing account */
export const billingAccount = config.requireSecret("billingAccount");

/** Standard resource labels */
export const env = config.get("env") || "production";
export const purpose =
	config.get("purpose") || gcpProject.replace(/-cluster$/, "");
export const gcpUser =
	config.get("user") ||
	execFileSync("gcloud", ["config", "get-value", "account"], {
		encoding: "utf8",
	}).trim();

/** Region to create resources */
export const region = gcpConfig.get("region") || "us-central1";

interface GkeConfig {
	channel?: string;
	location?: string;
	machineType?: string;
	masterAuthorizedNetworkCidrBlocks?: gcp.types.input.container.ClusterMasterAuthorizedNetworksConfigCidrBlock[];
	maxNodeCount?: number;
	minNodeCount?: number;
	zones?: string[];
}
const gkeConfig = config.getObject<GkeConfig>("gke") || {};

/** Master authorized network CIDR blocks. */
export const masterAuthorizedNetworkCidrBlocks =
	gkeConfig.masterAuthorizedNetworkCidrBlocks;

/** GKE release channel */
export const channel = gkeConfig.channel || "REGULAR";

/** GKE cluster location */
export const location = gkeConfig.location || region;

/** Autoscaling */
export const maxNodeCount = gkeConfig.maxNodeCount || 3;
export const minNodeCount = gkeConfig.minNodeCount || 1;

/** Kubernetes node machine type */
export const machineType = gkeConfig.machineType || "e2-standard-2";

/** Optional cluster node zones. */
export const zones = gkeConfig.zones;

/** DNS zone name */
export const dnsName = config.require("dnsName");
