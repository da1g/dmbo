FROM rust:1.75-bookworm AS builder
WORKDIR /app
COPY orchestrator/Cargo.toml orchestrator/Cargo.toml
COPY orchestrator/src orchestrator/src
RUN cargo build --manifest-path orchestrator/Cargo.toml --release

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/orchestrator/target/release/dmbo-orchestrator /usr/local/bin/dmbo-orchestrator
ENV DMBO_BIND=0.0.0.0:8787 \
    REDIS_URL=redis://redis:6379/
EXPOSE 8787
CMD ["dmbo-orchestrator"]
