FROM ruby:3.4.4-slim AS builder

RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN gem install openclacky --no-document

FROM ruby:3.4.4-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bundle /usr/local/bundle

RUN curl https://mise.run | sh
ENV PATH="/root/.local/bin:$PATH"

VOLUME ["/root/.clacky"]

EXPOSE 7070

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:7070/health || exit 1

ENTRYPOINT ["openclacky"]
CMD ["server", "--host", "0.0.0.0"]
