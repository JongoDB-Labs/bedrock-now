# The e2e browser suite's runner: the pinned Playwright image (Chromium 1187 for playwright 1.55.0) plus the
# hash-pinned Python package. Built and removed by tests/e2e/browser.sh; never shipped.
ARG PW_IMAGE
FROM ${PW_IMAGE}
COPY requirements.txt /tmp/requirements.txt
RUN pip install -q --no-cache-dir --break-system-packages --root-user-action=ignore --require-hashes --only-binary :all: \
      -r /tmp/requirements.txt \
 && python3 -c "import importlib.metadata as m; assert m.version('playwright') == '1.55.0'"
WORKDIR /suite
