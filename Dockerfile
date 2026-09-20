# --- STAGE 1: Build ---
FROM python:3.12-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get -qq update \
  && apt-get -q -y install --no-install-recommends \
    build-essential \
  && apt-get clean all \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -g users -m build

WORKDIR /home/build

COPY pyproject.toml README.md /home/build/
COPY server /home/build/server

USER build

RUN pip install --upgrade --no-cache-dir pip \
 && pip install --no-cache-dir --user .


# --- STAGE 2: Application ---
FROM python:3.12-slim

ARG HOST_UID=1000
ARG HOST_GID=1000
ARG LOCAL_USER=app
ARG LOCAL_GROUP=users

RUN groupmod -g "$HOST_GID" "$LOCAL_GROUP" \
 && useradd -u "$HOST_UID" -g "$LOCAL_GROUP" -m "$LOCAL_USER"

COPY --chown=$LOCAL_USER:$LOCAL_GROUP --from=builder /home/build/.local /home/$LOCAL_USER/.local
COPY --chown=$LOCAL_USER:$LOCAL_GROUP server /home/$LOCAL_USER/server
COPY --chown=$LOCAL_USER:$LOCAL_GROUP app /home/$LOCAL_USER/app

WORKDIR /home/$LOCAL_USER

USER $LOCAL_USER

ENV PATH=/home/$LOCAL_USER/.local/bin:$PATH
ENV PYTHONUNBUFFERED=1

EXPOSE 9000

ENTRYPOINT ["python3", "server/replay_server.py", "--host", "0.0.0.0", "--port", "9000"]
