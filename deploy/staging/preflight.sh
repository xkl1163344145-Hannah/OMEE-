#!/usr/bin/env bash
# 只读检查。请在目标腾讯云主机上执行；不输出环境变量、密码或密钥。
set -euo pipefail
printf '== system ==\n'
uname -sr
printf '== resources ==\n'
free -m
df -h / /opt 2>/dev/null || df -h /
printf '== listeners ==\n'
ss -ltn | awk 'NR==1 || /:(22|80|443|3000|3100|3200|3301)[[:space:]]/'
printf '== runtimes ==\n'
command -v node >/dev/null && node --version || true
command -v docker >/dev/null && docker --version || true
command -v docker >/dev/null && docker compose version || true
command -v nginx >/dev/null && nginx -v 2>&1 || true
printf '== existing container names and exposed ports ==\n'
if command -v docker >/dev/null; then docker ps --format '{{.Names}} {{.Ports}}' || true; fi
printf '只读检查完成；尚未安装、重启、开放端口或修改任何服务。\n'
