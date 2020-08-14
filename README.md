# iac-gke

Infrastructure-as-Code repository of for a production-ready GKE
environment. See
[https://blog.atomist.com/kubernetes-ingress-nginx-cert-manager-external-dns][blog]
for details.

[blog]: https://blog.atomist.com/kubernetes-ingress-nginx-cert-manager-external-dns "Kubernetes, ingress-nginx, cert-manager & external-dns - Atomist blog"

## Executing

The resources are defined using the [Pulumi][pulumi] SDK. You will
need to install the [Pulumi CLI][pulumi-cli].

[pulumi]: https://www.pulumi.com/
[pulumi-cli]: https://www.pulumi.com/docs/get-started/install/

After making changes, you can effect the changes with the following
command.

```
$ pulumi up
```
