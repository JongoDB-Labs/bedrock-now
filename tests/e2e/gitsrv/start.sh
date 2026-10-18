#!/bin/sh
# The e2e git server's start: a CA and a certificate for gitsrv, the repository, sshd, then the HTTPS server as git.
set -eu
umask 022
d=/srv/tls
mkdir -p "$d" /srv/git/e2e /run/sshd
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$d/ca.key" -out "$d/ca.pem" -days 2 -subj '/CN=bedrock-now e2e git CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$d/srv.key" -out "$d/srv.csr" -subj '/CN=gitsrv' 2>/dev/null
printf 'subjectAltName=DNS:gitsrv,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > "$d/ext.cnf"
openssl x509 -req -in "$d/srv.csr" -CA "$d/ca.pem" -CAkey "$d/ca.key" -CAcreateserial -out "$d/srv.pem" -days 2 -extfile "$d/ext.cnf" 2>/dev/null
cp "$d/ca.pem" /srv/ca.pem
chown -R git "$d" /srv/git
[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
su git -s /bin/sh -c 'set -e; cd /srv/git/e2e; git init -q --bare -b main demo.git; git -C demo.git config http.receivepack true
  w=$(mktemp -d); cd "$w"; git init -q -b main; printf "# e2e demo\n" > README.md; git add README.md
  git -c user.name=e2e -c user.email=e2e@example.invalid commit -qm "first"; git push -q /srv/git/e2e/demo.git main; rm -rf "$w"'
/usr/sbin/sshd -f /etc/ssh/sshd_e2e -E /tmp/sshd.log
echo ready
exec su git -s /bin/sh -c 'exec node /srv/https.mjs'
