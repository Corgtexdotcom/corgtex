#!/usr/bin/env python3
"""Preliminary Ops catalogs only. No leases, provider login, or migration imports."""
import base64
import datetime as dt
import hashlib
import json
import os
import re
import resource
import selectors
import signal
import socket
import ssl
import struct
import subprocess
import sys
import time
from urllib.parse import parse_qsl, unquote, urlsplit

HOST = "switchback.proxy.rlwy.net"
PORT = 45900
PROJECT = "42d177e6-0f16-4878-9fb3-f65e6153ad2c"
ENVIRONMENT = "30b16f74-9443-4184-99cc-73ca595ebb3a"
SERVICE = "f2498777-f21f-42b8-b836-84ebf7cbf088"
IMAGE = "docker.io/library/postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280"
NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,62}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")

SQL = r"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '10s';
SET LOCAL transaction_timeout = '20s';
SELECT (pg_catalog.current_setting('transaction_read_only')='on'
 AND pg_catalog.current_setting('search_path')='pg_catalog'
 AND pg_catalog.current_setting('server_version_num')::integer BETWEEN 180000 AND 189999
 AND NOT pg_catalog.pg_is_in_recovery()
 AND pg_catalog.current_database()=:'expected_database'
 AND current_user=:'expected_user' AND session_user=:'expected_user'
 AND (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      FROM pg_catalog.pg_roles WHERE rolname=current_user)
 AND (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid())
) AS source_catalog_gate \gset
\if :source_catalog_gate
SELECT pg_catalog.json_build_object(
 'identity',(SELECT pg_catalog.row_to_json(x) FROM (
  SELECT pg_catalog.current_database() AS database, current_user::text AS role,
   session_user::text AS login, d.oid::text AS database_oid,
   pg_catalog.current_setting('server_version_num')::integer AS version,
   pg_catalog.current_setting('transaction_read_only') AS read_only,
   pg_catalog.current_setting('search_path') AS search_path,
   pg_catalog.pg_is_in_recovery() AS recovering
  FROM pg_catalog.pg_database d WHERE datname=pg_catalog.current_database()
 ) x),
 'databases',(SELECT COALESCE(pg_catalog.json_agg(x),'[]'::json) FROM (
  SELECT datname AS name, oid::text AS oid, pg_catalog.pg_get_userbyid(datdba) AS owner,
   datistemplate AS is_template, datallowconn AS allow_connections
  FROM pg_catalog.pg_database ORDER BY oid LIMIT 129
 ) x),
 'roles',(SELECT COALESCE(pg_catalog.json_agg(x),'[]'::json) FROM (
  SELECT rolname AS name, oid::text AS oid, rolcanlogin AS can_login,
   rolsuper AS superuser, rolcreatedb AS create_database, rolcreaterole AS create_role,
   rolreplication AS replication, rolbypassrls AS bypass_rls, rolinherit AS inherit
  FROM pg_catalog.pg_roles ORDER BY oid LIMIT 257
 ) x),
 'memberships',(SELECT COALESCE(pg_catalog.json_agg(x),'[]'::json) FROM (
  SELECT roleid::text AS role_oid, member::text AS member_oid,
   grantor::text AS grantor_oid, admin_option, inherit_option, set_option
  FROM pg_catalog.pg_auth_members ORDER BY roleid,member,grantor LIMIT 1025
 ) x)
);
ROLLBACK;
\else
ROLLBACK;
\quit 3
\endif
"""

# Input is three bounded base64 lines. Only tmpfs files ever hold the passfile/CA.
CLIENT = r"""set -eu
ulimit -c 0
umask 077
IFS= read -r ca
IFS= read -r pass
IFS= read -r sql
printf '%s' "$ca" | base64 -d > /run/discovery/root.crt
printf '%s' "$pass" | base64 -d > /run/discovery/pgpass
printf '%s' "$sql" | base64 -d > /run/discovery/query.sql
unset ca pass sql
exec env -i HOME=/nonexistent PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C \
 PGPASSFILE=/run/discovery/pgpass PGSSLROOTCERT=/run/discovery/root.crt \
 PGSSLMODE=verify-full PGSSLMINPROTOCOLVERSION=TLSv1.2 PGGSSENCMODE=disable \
 PGSSLCERTMODE=disable PGCONNECT_TIMEOUT=5 PGAPPNAME=corgtex-ops-source-catalog \
 PGOPTIONS='-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000 -c transaction_timeout=20000' \
 psql -X -w -qAt --set ON_ERROR_STOP=1 --host "$1" --port "$2" \
 --dbname "$3" --username "$4" --set "expected_database=$3" \
 --set "expected_user=$4" --file /run/discovery/query.sql 2>/dev/null
"""

class Stop(Exception):
    pass

def require(ok, code):
    if not ok:
        raise Stop(code)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

def digest(value):
    return hashlib.sha256(value).hexdigest()

def parse_binding(raw, certificate):
    require(isinstance(raw, str) and 0 < len(raw.encode()) <= 8192, "SOURCE_URL_MISSING_OR_OVERSIZE")
    require(not re.search(r"[\x00-\x20\x7f]", raw), "SOURCE_URL_INVALID")
    try:
        u = urlsplit(raw)
        params = parse_qsl(u.query, keep_blank_values=True, strict_parsing=True)
        port = u.port
        username = unquote(u.username or "", errors="strict")
        password = unquote(u.password or "", errors="strict")
        database = unquote(u.path[1:], errors="strict") if u.path.startswith("/") else ""
    except (ValueError, UnicodeError):
        raise Stop("SOURCE_URL_INVALID") from None
    require(u.scheme in ("postgres", "postgresql") and not u.fragment, "SOURCE_URL_INVALID")
    require(u.hostname == HOST and port == PORT, "SOURCE_ENDPOINT_BINDING_MISMATCH")
    require(params in ([('sslmode', 'require')], [('sslmode', 'verify-full')]), "SOURCE_TLS_OPTIONS_REJECTED")
    require(NAME.fullmatch(username) and NAME.fullmatch(database), "SOURCE_IDENTITY_FIELD_REJECTED")
    require(0 < len(password.encode()) <= 4096 and not re.search(r"[\x00-\x1f\x7f]", password), "SOURCE_PASSWORD_INVALID")
    require(isinstance(certificate, str) and 0 < len(certificate.encode()) <= 16384, "SOURCE_CA_MISSING_OR_OVERSIZE")
    normalized = certificate.replace("\r\n", "\n").strip()
    require(re.fullmatch(r"-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----", normalized), "SOURCE_CA_INVALID")
    try:
        der = ssl.PEM_cert_to_DER_cert(normalized)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.verify_mode = ssl.CERT_REQUIRED
        context.check_hostname = True
        context.load_verify_locations(cadata=normalized)
    except (ValueError, ssl.SSLError):
        raise Stop("SOURCE_CA_INVALID") from None
    return {'host': HOST, 'port': PORT, 'user': username, 'password': password,
            'database': database, 'ca': normalized+'\n', 'caSha256': digest(der), 'context': context}

def transport_probe(binding, connect=socket.create_connection):
    # PostgreSQL SSLRequest only: no StartupMessage, username or password sent.
    try:
        with connect((binding['host'], binding['port']), timeout=5) as sock:
            sock.settimeout(5)
            sock.sendall(struct.pack('!II', 8, 80877103))
            require(sock.recv(1) == b'S', "SOURCE_TLS_NOT_SUPPORTED")
            with binding['context'].wrap_socket(sock, server_hostname=binding['host']) as secured:
                return {'verified': True, 'hostnameVerified': True,
                        'peerCertificateSha256': digest(secured.getpeercert(binary_form=True)),
                        'caSha256': binding['caSha256']}
    except ssl.SSLCertVerificationError as error:
        raise Stop("SOURCE_TLS_HOSTNAME_MISMATCH" if error.verify_code == 62 else "SOURCE_TLS_CERTIFICATE_REJECTED") from None
    except (OSError, ssl.SSLError):
        raise Stop("SOURCE_TLS_TRANSPORT_FAILED") from None

class Runner:
    def __init__(self, seconds=100):
        self.deadline = time.monotonic()+seconds

    def run(self, args, payload=b'', seconds=10, maximum=65536):
        require(time.monotonic() < self.deadline, "WHOLE_OPERATION_TIMEOUT")
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, start_new_session=True,
            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C'})
        output = bytearray()
        selector = selectors.DefaultSelector()
        os.set_blocking(process.stdout.fileno(), False)
        os.set_blocking(process.stdin.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        if payload:
            selector.register(process.stdin, selectors.EVENT_WRITE)
        else:
            process.stdin.close()
        sent = 0
        end = min(self.deadline, time.monotonic()+seconds)
        try:
            while selector.get_map():
                require(time.monotonic() < end, "CLIENT_TIMEOUT")
                for key, event in selector.select(min(.2, max(0, end-time.monotonic()))):
                    if event == selectors.EVENT_WRITE:
                        try:
                            sent += os.write(key.fd, payload[sent:sent+4096])
                        except BrokenPipeError:
                            sent = len(payload)
                        if sent == len(payload):
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                    else:
                        data = os.read(key.fd, 4096)
                        if not data:
                            selector.unregister(key.fileobj)
                        else:
                            output.extend(data)
                            require(len(output) <= maximum, "CLIENT_OUTPUT_BOUND")
            code = process.wait(timeout=max(.01, end-time.monotonic()))
            require(code == 0, "CLIENT_OR_CATALOG_REJECTED")
            return bytes(output)
        except subprocess.TimeoutExpired:
            raise Stop("CLIENT_TIMEOUT") from None
        finally:
            selector.close()
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=2)
            for stream in (process.stdin, process.stdout):
                if not stream.closed:
                    stream.close()

def observe_catalog(binding, runner):
    created = None
    cleaned = False
    try:
        created = runner.run(['docker', 'create', '--pull=never', '--interactive',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--log-driver=none', '--memory=256m', '--memory-swap=256m', '--pids-limit=64',
            '--tmpfs=/run/discovery:rw,noexec,nosuid,nodev,size=1m,mode=0700',
            '--entrypoint=/bin/sh', IMAGE, '-c', CLIENT, 'source-catalog',
            binding['host'], str(binding['port']), binding['database'], binding['user']]).decode().strip()
        require(re.fullmatch(r'[0-9a-f]{64}', created), "CLIENT_CONTAINER_ID_INVALID")
        escape = lambda x: x.replace('\\', '\\\\').replace(':', '\\:')
        passfile = ':'.join(escape(str(binding[k])) for k in ('host','port','database','user','password'))+'\n'
        payload = b''.join(base64.b64encode(x.encode())+b'\n' for x in (binding['ca'], passfile, SQL))
        require(len(payload) <= 65536, "CLIENT_INPUT_BOUND")
        raw = runner.run(['docker', 'start', '--attach', '--interactive', created], payload, seconds=40)
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise Stop("CATALOG_JSON_INVALID") from None
        return summarize(result, binding)
    finally:
        if created and re.fullmatch(r'[0-9a-f]{64}', created):
            try:
                runner.run(['docker', 'rm', '--force', created], seconds=10, maximum=256)
                cleaned = True
            except (Stop, OSError):
                pass
            require(cleaned, "EPHEMERAL_CLIENT_CLEANUP_UNCONFIRMED")

def exact(row, fields):
    require(isinstance(row, dict) and set(row) == set(fields), "CATALOG_SHAPE_REJECTED")

def oid(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[1-9][0-9]{0,9}', value)) and int(value) <= 4294967295

def summarize(data, binding):
    exact(data, ('identity', 'databases', 'roles', 'memberships'))
    identity = data['identity']
    exact(identity, ('database','role','login','database_oid','version','read_only','search_path','recovering'))
    require(identity['database'] == binding['database'] and identity['role'] == binding['user']
        and identity['login'] == binding['user'] and oid(identity['database_oid'])
        and type(identity['version']) is int and 180000 <= identity['version'] < 190000
        and identity['read_only'] == 'on' and identity['search_path'] == 'pg_catalog'
        and identity['recovering'] is False, "CATALOG_IDENTITY_REJECTED")
    for name, maximum in [('databases',128),('roles',256),('memberships',1024)]:
        require(isinstance(data[name],list) and len(data[name]) <= maximum, "CATALOG_ROW_BOUND")
    for row in data['databases']:
        exact(row, ('name','oid','owner','is_template','allow_connections'))
        require(NAME.fullmatch(row['name']) and NAME.fullmatch(row['owner']) and oid(row['oid'])
            and type(row['is_template']) is bool and type(row['allow_connections']) is bool, "CATALOG_FIELD_REJECTED")
    flags = ('can_login','superuser','create_database','create_role','replication','bypass_rls','inherit')
    for row in data['roles']:
        exact(row, ('name','oid',*flags))
        require(NAME.fullmatch(row['name']) and oid(row['oid'])
            and all(type(row[f]) is bool for f in flags), "CATALOG_FIELD_REJECTED")
    own = [r for r in data['roles'] if r['name'] == binding['user']]
    require(len(own)==1 and own[0]['can_login'] and not any(own[0][f] for f in flags[1:-1]), "SOURCE_ROLE_TOO_POWERFUL_OR_UNBOUND")
    current = [r for r in data['databases'] if r['name']==binding['database'] and r['oid']==identity['database_oid']]
    require(len(current)==1 and current[0]['allow_connections'] and not current[0]['is_template'], "SOURCE_DATABASE_UNBOUND")
    for row in data['memberships']:
        exact(row, ('role_oid','member_oid','grantor_oid','admin_option','inherit_option','set_option'))
        require(all(oid(row[k]) for k in ('role_oid','member_oid','grantor_oid'))
            and all(type(row[k]) is bool for k in ('admin_option','inherit_option','set_option')), "CATALOG_FIELD_REJECTED")
    # Repository is public: never persist/log actual database names, roles, CA or URL.
    return {'catalogCounts': {n:len(data[n]) for n in ('databases','roles','memberships')},
        'catalogSha256': digest(canonical(data)), 'connectionBindingSha256': digest(canonical({k:binding[k] for k in ('host','port','database','user')})),
        'currentDatabaseOid': identity['database_oid'], 'postgresVersion': identity['version'],
        'readOnly': True, 'powerfulDirectRoleFlagsAbsent': True, 'credentialPrivilegeAttested': False,
        'rawNamesRetained': False, 'clusterSystemIdentifier': None}

def workflow_guard(env, now=None):
    require(env.get('GITHUB_REPOSITORY')=='Corgtexdotcom/corgtex' and env.get('GITHUB_REF')=='refs/heads/main'
        and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('GITHUB_RUN_ATTEMPT')=='1', "WORKFLOW_CONTEXT_REJECTED")
    sha = env.get('GITHUB_SHA','')
    require(re.fullmatch(r'[0-9a-f]{40}',sha) and sha==env.get('REVIEWED_SHA')==env.get('WORKFLOW_SHA'), "REVIEWED_HEAD_MISMATCH")
    require(SHA.fullmatch(env.get('PROVIDER_BINDING_SHA256','')), "PROVIDER_RECEIPT_REQUIRED")
    try:
        observed = dt.datetime.fromisoformat(env.get('PROVIDER_OBSERVED_AT','').replace('Z','+00:00'))
        age = ((now or dt.datetime.now(dt.timezone.utc))-observed).total_seconds()
    except (TypeError, ValueError):
        raise Stop("PROVIDER_RECEIPT_TIME_INVALID") from None
    require(0 <= age <= 3600, "PROVIDER_RECEIPT_STALE_OR_FUTURE")

def execute(env, runner=None, probe=transport_probe):
    workflow_guard(env)
    binding = parse_binding(env.get('SOURCE_DATABASE_URL'), env.get('SOURCE_TLS_ROOT_CERT'))
    transport = probe(binding)
    result = observe_catalog(binding, runner or Runner())
    result.update({'status':'PRELIMINARY_CATALOG_OBSERVED', 'tls':transport,
        'source':{'projectId':PROJECT,'environmentId':ENVIRONMENT,'postgresServiceId':SERVICE,'proxyHost':HOST,'proxyPort':PORT},
        'reviewedSha':env['GITHUB_SHA'], 'providerReceiptSha256':env['PROVIDER_BINDING_SHA256'],
        'providerReceiptVerifiedByJob':False, 'vendorFilesObserved':False,
        'custodyReady':False, 'migrationAuthorized':False, 'cleanupConfirmed':True})
    return result

def main():
    if sys.argv[1:] != ['--observe-approved']:
        print(json.dumps({'state':'SOURCE_ONLY_DRAFT','executionAllowed':False,'custodyReady':False}))
        return 0
    resource.setrlimit(resource.RLIMIT_CORE, (0,0))
    os.umask(0o077)
    try:
        result = execute(dict(os.environ))
    except Stop as error:
        print(json.dumps({'status':'STOP','code':str(error),'custodyReady':False,'migrationAuthorized':False}))
        return 1
    except Exception:
        print(json.dumps({'status':'STOP','code':'UNEXPECTED_LOCAL_FAILURE','custodyReady':False,'migrationAuthorized':False}))
        return 1
    print(json.dumps(result,sort_keys=True))
    return 0

if __name__ == '__main__':
    sys.exit(main())
