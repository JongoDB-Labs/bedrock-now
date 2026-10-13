# The portal's test image plus Chromium on a virtual display: for check.py only (run.sh), never shipped.
ARG BASE=bedrock-now-portal-e2e-base
FROM ${BASE}
USER root
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends chromium xvfb xauth xdotool imagemagick >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && pip install -q --no-cache-dir --root-user-action=ignore websocket-client==1.8.0 \
 # root in a container: Chromium's sandbox needs namespaces it does not get here (also for the app it installs)
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox"' > /etc/chromium.d/zz-container-no-sandbox
COPY check.py /check.py
