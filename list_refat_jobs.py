#!/usr/bin/env python3
"""Lista os jobs de um workspace Databricks cujo nome termina com um sufixo.

Uso:
    export DATABRICKS_HOST=https://dbc-535d1d75-6727.cloud.databricks.com
    export DATABRICKS_TOKEN=dapi...
    python3 list_refat_jobs.py                 # sufixo padrao: _refat
    python3 list_refat_jobs.py --suffix _refat --json

Usa apenas a biblioteca padrao do Python (sem dependencias externas).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API_PATH = "/api/2.2/jobs/list"
PAGE_SIZE = 100


def fetch_all_jobs(host, token):
    """Percorre todas as paginas de /api/2.2/jobs/list e devolve a lista de jobs."""
    jobs = []
    page_token = None

    while True:
        params = {"limit": PAGE_SIZE, "expand_tasks": "false"}
        if page_token:
            params["page_token"] = page_token

        url = host.rstrip("/") + API_PATH + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": "Bearer " + token,
                "Accept": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.load(resp)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            sys.exit("Erro HTTP {} ao chamar {}: {}".format(exc.code, API_PATH, body))
        except urllib.error.URLError as exc:
            sys.exit("Falha de rede ao acessar {}: {}".format(host, exc.reason))

        jobs.extend(payload.get("jobs", []))

        page_token = payload.get("next_page_token")
        if not page_token:
            return jobs


def job_name(job):
    return job.get("settings", {}).get("name", "") or ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suffix", default="_refat", help="sufixo do nome do job (padrao: _refat)")
    parser.add_argument("--host", default=os.environ.get("DATABRICKS_HOST"), help="URL do workspace")
    parser.add_argument("--token", default=os.environ.get("DATABRICKS_TOKEN"), help="personal access token")
    parser.add_argument("--case-sensitive", action="store_true", help="comparar o sufixo respeitando maiusculas")
    parser.add_argument("--json", action="store_true", help="imprimir o resultado em JSON")
    args = parser.parse_args()

    if not args.host:
        sys.exit("Defina DATABRICKS_HOST (ou use --host).")
    if not args.token:
        sys.exit("Defina DATABRICKS_TOKEN (ou use --token).")

    jobs = fetch_all_jobs(args.host, args.token)

    if args.case_sensitive:
        matches = [j for j in jobs if job_name(j).endswith(args.suffix)]
    else:
        suffix = args.suffix.lower()
        matches = [j for j in jobs if job_name(j).lower().endswith(suffix)]

    matches.sort(key=lambda j: job_name(j).lower())

    if args.json:
        print(json.dumps(
            [{"job_id": j.get("job_id"), "name": job_name(j), "creator": j.get("creator_user_name")}
             for j in matches],
            indent=2,
            ensure_ascii=False,
        ))
        return

    print("{} de {} jobs terminam com '{}'\n".format(len(matches), len(jobs), args.suffix))
    if not matches:
        return

    width = max(len(job_name(j)) for j in matches)
    print("{:<{w}}  {:>12}  {}".format("NOME", "JOB_ID", "CRIADOR", w=width))
    print("-" * (width + 16 + len("CRIADOR")))
    for j in matches:
        print("{:<{w}}  {:>12}  {}".format(
            job_name(j), j.get("job_id", ""), j.get("creator_user_name", "") or "-", w=width))


if __name__ == "__main__":
    main()
