# Sourced by deploy-local.sh (and its test).
# The bridge token, on stdout: the home's token file, else (a home not migrated yet) config.json's token. Never logged by the caller.
read_token() {
  local home="${ONCE_UPON_HOME:-$HOME/.once-upon}" tok=""
  [ -r "$home/token" ] && tok="$(tr -d '[:space:]' <"$home/token")"
  if [ -z "$tok" ] && [ -r "$home/config.json" ]; then
    tok="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token||""))' "$home/config.json" 2>/dev/null)" || tok=""
  fi
  printf '%s' "$tok"
}
