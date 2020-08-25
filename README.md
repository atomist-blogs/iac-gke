# iac-gke

Infrastructure-as-Code repository of for a production-ready GKE
environment. See
[https://blog.atomist.com/kubernetes-ingress-nginx-cert-manager-external-dns][blog]
for details.

[blog]: https://blog.atomist.com/kubernetes-ingress-nginx-cert-manager-external-dns "Kubernetes, ingress-nginx, cert-manager & external-dns - Atomist blog"

## Executing

The resources are defined using the [Pulumi][pulumi] SDK. You will
need to install the [Pulumi CLI][pulumi-cli] and [Node.js][node].

[pulumi]: https://www.pulumi.com/
[pulumi-cli]: https://www.pulumi.com/docs/get-started/install/
[node]: https://nodejs.org/en/

Next, install the NPM dependencies.

```
$ npm ci
```

Then add the necessary configuration values, replacing the last
argument in the commands below with appropriate values.

```
$ pulumi config set gcp:project GCP_PROJECT
$ pulumi config set --secret billingAccount BILLING-ACCOUNT-ID
$ pulumi config set dnsName DNS.DOMAIN.
```

Finally, you can spin up all the resources with the following command.

```
$ pulumi up
```
