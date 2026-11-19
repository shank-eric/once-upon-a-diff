# Sourced by deploy-local.sh (and its test).
# The bridge token, on stdout: the home's token file. Never logged by the caller.
read_token() {
  local home="${ONCE_UPON_HOME:-$HOME/.once-upon}" tok=""
  [ -r "$home/token" ] && tok="$(tr -d '[:space:]' <"$home/token")"
  printf '%s' "$tok"
}
