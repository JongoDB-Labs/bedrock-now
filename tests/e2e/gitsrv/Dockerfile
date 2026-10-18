# The e2e suite's own git server (tests/e2e/run.sh with E2E_GIT_SERVER=1; never part of a stack): smart HTTPS with
# Basic auth (git http-backend behind Node's https; a CA made at start, which run.sh hands the browser suite) and SSH
# on port 2222 (sshd, which takes any key for the user git: the Code page's own key is new each run), on the
# throwaway's terminal-out network as "gitsrv". One repository, e2e/demo.git, with a first commit on main.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache "git~2.54" "git-daemon~2.54" "nodejs~24" openssh-server openssl \
 && adduser -D -h /srv/git -s /bin/sh git && sed -i 's/^git:!/git:*/' /etc/shadow \
 && printf '#!/bin/sh\n# sshd AuthorizedKeysCommand: whatever key is offered (a test server only)\necho "$1 $2"\n' > /usr/local/bin/anykey \
 && chmod 755 /usr/local/bin/anykey
COPY sshd_config /etc/ssh/sshd_e2e
COPY https.mjs start.sh /srv/
RUN chmod 644 /etc/ssh/sshd_e2e /srv/https.mjs && chmod 755 /srv/start.sh
EXPOSE 8443 2222
CMD ["/srv/start.sh"]
