# shellcheck shell=bash
# shellcheck disable=SC2034  # read by the libs that source this
# The project's names, in one place (sourced by lib/common.sh). Nothing here changes what is shown: this release still
# says bedrock-now everywhere; the NEXT names are only ever looked for, never shown.
#   PRODUCT_NAME       the name a person reads (the installed web app's name: portal_app_name, lib/portal.sh)
#   PRODUCT_NAME_NEXT  the name the project is being renamed to: ./stack open also finds an app installed under it
#   PRODUCT_REPO       the GitHub repository origin has today
#   PRODUCT_REPO_NEXT  the one it is being renamed to: GitHub redirects the old name there, and lib/repo_rename.sh moves
#                      origin to it once it exists (portal/portal/updates.py has the same two names: a test checks)
PRODUCT_NAME="bedrock-now"
PRODUCT_NAME_NEXT="DevOS ADE"
PRODUCT_REPO="JongoDB-Labs/bedrock-now"
PRODUCT_REPO_NEXT="JongoDB-Labs/devos-ade"
