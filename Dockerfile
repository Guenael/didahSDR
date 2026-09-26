# --- STAGE 1: Build ---
FROM python:3.14-slim AS builder

RUN useradd -g users -m build
WORKDIR /home/build

COPY pyproject.toml README.md LICENSE /home/build/
COPY server /home/build/server

USER build
RUN pip install --no-cache-dir --user .


# --- STAGE 2: CW decoder runtime (onnxruntime-web) ---
FROM python:3.14-slim AS ort

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get -qq update \
  && apt-get -q -y install --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY scripts/fetch_ort.sh scripts/fetch_ort.sh
RUN bash scripts/fetch_ort.sh


# --- STAGE 3: Application ---
FROM python:3.14-slim

ARG HOST_UID=1000
ARG HOST_GID=1000
ARG LOCAL_USER=app
ARG LOCAL_GROUP=users

RUN groupmod -g "$HOST_GID" "$LOCAL_GROUP" \
 && useradd -u "$HOST_UID" -g "$LOCAL_GROUP" -m "$LOCAL_USER"

COPY --chown=$LOCAL_USER:$LOCAL_GROUP --from=builder /home/build/.local /home/$LOCAL_USER/.local
COPY --chown=$LOCAL_USER:$LOCAL_GROUP server /home/$LOCAL_USER/server
# app/ includes app/models when the ONNX model is present in the build context (it is not in git)
COPY --chown=$LOCAL_USER:$LOCAL_GROUP app /home/$LOCAL_USER/app
COPY --chown=$LOCAL_USER:$LOCAL_GROUP --from=ort /src/app/lib /home/$LOCAL_USER/app/lib

WORKDIR /home/$LOCAL_USER

USER $LOCAL_USER

ENV PATH=/home/$LOCAL_USER/.local/bin:$PATH
ENV PYTHONUNBUFFERED=1

EXPOSE 9000

ENTRYPOINT ["python3", "server/replay_server.py", "--host", "0.0.0.0", "--port", "9000"]

# Mount your samples directory in your docker run command, e.g.:
# `docker run --rm --mount type=bind,src=/samples,dst=/home/app/samples,readonly -p 172.17.0.1:9000:9000 didahsdr:latest &`
# `podman ... --wav /home/app/samples/my_iq.wav --center-freq 14048000 -p 9000:9000
