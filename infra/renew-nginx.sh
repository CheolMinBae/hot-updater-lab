#!/bin/sh
set -eu
# Certbot calls this after renewal, so Nginx starts using the new certificate.
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
