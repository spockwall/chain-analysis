# Kubernetes manifests

Dev-targeted manifests for the full chain-analysis stack. Single-node
cluster assumed (kind / minikube / Docker Desktop K8s). Production
overlay (managed K8s + managed databases) is a follow-up — see the
"prod migration" notes at the bottom.

## Layout

```
k8s/
├── namespace.yaml            # Namespace: chain-analysis
├── secret.example.yaml       # TEMPLATE — shared Secret across all components
├── worker/                   # Rust worker (3 replicas, Issue #3)
│   ├── configmap.yaml
│   └── deployment.yaml
├── infra/                    # Stateful tier (StatefulSet + PVC)
│   ├── redis.yaml
│   ├── postgres.yaml
│   └── neo4j.yaml
└── app/                      # Application tier
    ├── backend.yaml          # FastAPI (single replica — entrypoint runs migrations)
    └── frontend.yaml         # Vite dev server
```

What's left as compose for now (not part of this migration):
- ClickHouse (not active in worker path)
- Dagster (dormant per CLAUDE.md)
- Prometheus / Grafana (observability — separate follow-up)

## Bring it up

```bash
# 1) Make sure your local K8s cluster is running and `kubectl` points at it.
kubectl cluster-info

# 2) Build the local images. K8s does not build — you build, then load.
docker build -f backend/Dockerfile  -t chain-analysis/backend:local .
docker build -f frontend/Dockerfile --target development \
                                     -t chain-analysis/frontend:local frontend
docker build -f etl-rs/Dockerfile  --target worker \
                                     -t chain-analysis/worker:local etl-rs

# Load images into the cluster (pick the one matching your local K8s):
#   kind:                kind load docker-image chain-analysis/{backend,frontend,worker}:local
#   minikube:            minikube image load chain-analysis/{backend,frontend,worker}:local
#   Docker Desktop K8s:  images on the host are already visible to the cluster.

# 3) Create the namespace and the shared Secret. The Secret is NOT applied
#    from secret.example.yaml — that file is a template documenting the
#    expected keys. Create the real Secret with `kubectl create secret`:
kubectl apply -f k8s/namespace.yaml

kubectl -n chain-analysis create secret generic chain-analysis-secrets \
  --from-literal=NEO4J_PASSWORD=changeme \
  --from-literal=POSTGRES_PASSWORD=changeme \
  --from-literal=DATABASE_URL=postgresql://postgres:changeme@postgres:5432/chain_analysis \
  --from-literal=JWT_SECRET_KEY=changeme \
  --from-literal=ETHERSCAN_API_KEY=YOUR_KEY_HERE \
  --from-literal=ALCHEMY_API_KEY=

# 4) Apply infra first (worker / backend depend on these being up).
kubectl apply -f k8s/infra/

# Wait for the stateful tier to be Ready before continuing — pg_isready /
# Neo4j HTTP probes have to pass.
kubectl -n chain-analysis rollout status statefulset/redis
kubectl -n chain-analysis rollout status statefulset/postgres
kubectl -n chain-analysis rollout status statefulset/neo4j

# 5) Apply backend (runs alembic + seeds on startup), then worker, then frontend.
kubectl apply -f k8s/app/backend.yaml
kubectl -n chain-analysis rollout status deployment/backend

kubectl apply -f k8s/worker/
kubectl apply -f k8s/app/frontend.yaml
```

## Access from your host

No Ingress in dev — use port-forward:

```bash
kubectl -n chain-analysis port-forward svc/backend  8000:8000   # http://localhost:8000
kubectl -n chain-analysis port-forward svc/frontend 5173:5173   # http://localhost:5173
kubectl -n chain-analysis port-forward svc/neo4j    7474:7474   # Neo4j browser
```

## Common operations

```bash
# All pods at a glance
kubectl -n chain-analysis get pods

# Worker logs from all 3 replicas, live
kubectl -n chain-analysis logs -f -l app=worker --max-log-requests=3 --tail=20

# Scale worker
kubectl -n chain-analysis scale deployment/worker --replicas=5

# Shell into a pod
kubectl -n chain-analysis exec -it deployment/backend -- /bin/sh

# Tear everything down
kubectl delete namespace chain-analysis
```

## What transfers from Issue #3 unchanged

The worker's multi-replica safety relies entirely on Redis-side
coordination, which is orchestrator-agnostic:

| Worker behaviour | Mechanism | K8s impact |
|---|---|---|
| Task A safely shares the targeted queue | Redis `BRPOP` atomic dispatch | None — works as-is |
| Task B only one replica refreshes per tick | Redis `SET refresh_lease NX EX` | None |
| Task C multi-consumer stream consumption | Redis consumer groups | None |
| Per-replica identity (lease owner id) | `replica_id()` reads `$HOSTNAME` | K8s sets each pod's hostname to its pod name (unique), so this just works |
| Cross-replica rate limiter | Redis fixed-window `INCR`+`EXPIRE` | None |

Worker source code is byte-identical between the compose and K8s
deployments — only `compose/etl.yml` vs `k8s/worker/deployment.yaml`
differ.

## Prod migration follow-ups (out of scope here)

These need decisions before the manifests can target prod:

1. **Cluster.** Managed (GKE / EKS / AKS) vs self-hosted (k3s / kubeadm).
   Affects ingress controller choice and PV storage class.
2. **Databases.** Run Postgres / Neo4j in-cluster (current manifests)
   vs managed services (Cloud SQL / AuraDB). In-cluster databases need a
   backup story (per roadmap Issue #8); managed services solve that for
   money.
3. **Image registry.** `imagePullPolicy: IfNotPresent` + local image
   loading works for single-node dev; multi-node prod needs images
   pushed to a registry (GHCR / ECR / Artifact Registry) and a
   `kubernetes.io/dockerconfigjson` Secret for pull auth.
4. **Ingress.** Frontend and backend currently only reachable via
   `port-forward`. For prod, add an `Ingress` resource per service plus
   an ingress controller (nginx-ingress / Traefik / managed).
5. **Secrets.** Out-of-band `kubectl create secret` is fine for dev.
   Prod should use sealed-secrets, External Secrets Operator, or the
   managed K8s integration with cloud secret managers.
6. **HPA.** Worker `replicas: 3` is fixed. Add a `HorizontalPodAutoscaler`
   targeting queue depth or CPU once a metric source is wired
   (Prometheus Adapter or KEDA).
