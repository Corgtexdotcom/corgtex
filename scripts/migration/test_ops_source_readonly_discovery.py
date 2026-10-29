"""Standalone synthetic tests. No real secrets, Docker, GitHub or provider access."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('observer', ROOT/'ops-source-readonly-discovery.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def catalog():
    return {'identity': {'database':'ops_db','role':'ops_reader','login':'ops_reader','database_oid':'16385',
        'version':180006,'read_only':'on','search_path':'pg_catalog','recovering':False},
        'databases':[{'name':'ops_db','oid':'16385','owner':'ops_owner','is_template':False,'allow_connections':True}],
        'roles':[{'name':'ops_reader','oid':'16386','can_login':True,'superuser':False,'create_database':False,
                  'create_role':False,'replication':False,'bypass_rls':False,'inherit':True}], 'memberships':[]}

class FakeRunner:
    def __init__(self, result=None, failure=False, cleanup_failure=False):
        self.calls=[]; self.result=result or catalog(); self.failure=failure; self.cleanup_failure=cleanup_failure
    def run(self,args,payload=b'',**kwargs):
        self.calls.append((args,payload,kwargs))
        if args[1]=='create': return b'a'*64+b'\n'
        if args[1]=='rm':
            if self.cleanup_failure: raise m.Stop('DUMMY_CLEANUP_FAILURE')
            return b'a'*64+b'\n'
        if self.failure: raise m.Stop('DUMMY_CLIENT_FAILURE')
        return json.dumps(self.result).encode()

class DiscoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='synthetic-source-tls-')
        p=Path(cls.temp.name)
        cls.key=p/'key.pem'; cls.cert=p/'cert.pem'
        cfg=p/'openssl.cnf'
        cfg.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n'
            '[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\n'
            'subjectAltName=DNS:localhost\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n'
            'extendedKeyUsage=serverAuth\n')
        subprocess.run([shutil.which('openssl'),'req','-x509','-newkey','rsa:2048','-sha256','-nodes',
            '-days','2','-keyout',str(cls.key),'-out',str(cls.cert),'-config',str(cfg)],
            check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        cls.ca=cls.cert.read_text()

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def binding(self, raw=None):
        return m.parse_binding(raw if raw is not None else f'postgresql://ops_reader:dummy%3Apassword@{m.HOST}:{m.PORT}/ops_db?sslmode=require',self.ca)

    def env(self):
        return {'GITHUB_REPOSITORY':'Corgtexdotcom/corgtex','GITHUB_REF':'refs/heads/main',
            'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'b'*40,
            'WORKFLOW_SHA':'b'*40,'REVIEWED_SHA':'b'*40,'PROVIDER_BINDING_SHA256':'c'*64,
            'PROVIDER_OBSERVED_AT':dt.datetime.now(dt.timezone.utc).isoformat(),
            'SOURCE_DATABASE_URL':f'postgresql://ops_reader:dummy%3Apassword@{m.HOST}:{m.PORT}/ops_db?sslmode=require',
            'SOURCE_TLS_ROOT_CERT':self.ca}

    def test_strict_tls_context_and_fixed_binding(self):
        b=self.binding()
        self.assertTrue(b['context'].check_hostname)
        self.assertEqual(b['context'].verify_mode,ssl.CERT_REQUIRED)
        self.assertEqual(b['password'],'dummy:password')

    def test_endpoint_drift_never_opens_socket(self):
        env=self.env(); env['SOURCE_DATABASE_URL']=env['SOURCE_DATABASE_URL'].replace(m.HOST,'elsewhere.invalid')
        with self.assertRaisesRegex(m.Stop,'ENDPOINT_BINDING_MISMATCH'):
            m.execute(env,FakeRunner(),probe=lambda _:self.fail('unexpected network'))

    def test_unsafe_url_options_rejected(self):
        for suffix in ['sslmode=disable','sslmode=prefer','sslmode=verify-ca',
                       'sslmode=require&options=-c+search_path=public','sslmode=require&sslmode=verify-full']:
            with self.subTest(suffix=suffix),self.assertRaises(m.Stop):
                self.binding(f'postgres://ops_reader:dummy@{m.HOST}:{m.PORT}/ops_db?{suffix}')

    def test_missing_or_malformed_credentials_rejected(self):
        for raw in ['',f'postgres://ops_reader@{m.HOST}:{m.PORT}/ops_db?sslmode=require',
                    f'postgres://ops_reader:dummy%0Asecret@{m.HOST}:{m.PORT}/ops_db?sslmode=require',
                    f'postgres://ops_reader:dummy@{m.HOST}:{m.PORT}/ops_db/other?sslmode=require']:
            with self.subTest(raw=raw),self.assertRaises(m.Stop): self.binding(raw)

    def test_bad_ca_rejected(self):
        for ca in ['', 'not-a-certificate', self.ca+self.ca]:
            with self.subTest(size=len(ca)),self.assertRaises(m.Stop):
                m.parse_binding(self.env()['SOURCE_DATABASE_URL'],ca)

    def serve(self):
        server=socket.socket()
        try:
            server.bind(('127.0.0.1',0)); server.listen(1)
        except Exception:
            server.close(); raise
        port=server.getsockname()[1]; observed=[]
        def task():
            try:
                conn,_=server.accept(); conn.settimeout(2)
                with conn:
                    observed.append(conn.recv(8)); conn.sendall(b'S')
                    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                    context.load_cert_chain(str(self.cert),str(self.key))
                    try:
                        with context.wrap_socket(conn,server_side=True) as tls:
                            observed.append(tls.recv(1))
                    except (ssl.SSLError,OSError): pass
            finally: server.close()
        thread=threading.Thread(target=task,daemon=True); thread.start()
        def connect(address,timeout): return socket.create_connection(('127.0.0.1',port),timeout)
        return connect,thread,observed

    def test_real_tls_probe_sends_no_startup_or_password(self):
        b=self.binding(); b['host']='localhost'
        connect,thread,observed=self.serve()
        result=m.transport_probe(b,connect=connect); thread.join(3)
        self.assertTrue(result['hostnameVerified'])
        self.assertEqual(observed,[b'\x00\x00\x00\x08\x04\xd2\x16/',b''])
        self.assertFalse(thread.is_alive())

    def test_real_hostname_mismatch_stops_before_catalog(self):
        b=self.binding(); b['host']='mismatch.invalid'
        connect,thread,observed=self.serve()
        with self.assertRaisesRegex(m.Stop,'HOSTNAME_MISMATCH'):
            m.transport_probe(b,connect=connect)
        thread.join(3)
        self.assertEqual(observed[0],b'\x00\x00\x00\x08\x04\xd2\x16/')

    def test_real_untrusted_certificate_is_rejected(self):
        b=self.binding(); b['host']='localhost'
        b['context']=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        b['context'].check_hostname=True
        b['context'].verify_mode=ssl.CERT_REQUIRED
        connect,thread,observed=self.serve()
        with self.assertRaisesRegex(m.Stop,'CERTIFICATE_REJECTED'):
            m.transport_probe(b,connect=connect)
        thread.join(3)
        self.assertEqual(observed[0],b'\x00\x00\x00\x08\x04\xd2\x16/')

    def test_tls_failure_never_starts_client(self):
        runner=FakeRunner()
        def stop(_): raise m.Stop('SOURCE_TLS_HOSTNAME_MISMATCH')
        with self.assertRaisesRegex(m.Stop,'HOSTNAME_MISMATCH'): m.execute(self.env(),runner,probe=stop)
        self.assertEqual(runner.calls,[])

    def test_workflow_guard_rejects_fork_branch_rerun_head_mismatch(self):
        for key,value in [('GITHUB_REPOSITORY','other/repo'),('GITHUB_REF','refs/heads/other'),
            ('GITHUB_EVENT_NAME','pull_request'),('GITHUB_RUN_ATTEMPT','2'),('REVIEWED_SHA','d'*40),('WORKFLOW_SHA','e'*40)]:
            env=self.env(); env[key]=value
            with self.subTest(key=key),self.assertRaises(m.Stop): m.workflow_guard(env)

    def test_provider_evidence_cannot_be_stale_future_or_missing(self):
        for value in ['', '2026-01-01T00:00:00Z','2999-01-01T00:00:00Z']:
            env=self.env(); env['PROVIDER_OBSERVED_AT']=value
            with self.subTest(value=value),self.assertRaises(m.Stop): m.workflow_guard(env)

    def test_client_credential_is_stdin_tmpfs_only_and_cleanup_runs(self):
        runner=FakeRunner(); result=m.observe_catalog(self.binding(),runner)
        create,start,cleanup=runner.calls
        self.assertNotIn('dummy',json.dumps(create[0]))
        self.assertIn('--log-driver=none',create[0]); self.assertIn('--pull=never',create[0])
        self.assertIn(m.IMAGE,create[0]); self.assertIn('PGSSLMODE=verify-full',m.CLIENT)
        self.assertTrue(start[1]); self.assertEqual(cleanup[0][1:3],['rm','--force'])
        self.assertFalse(result['rawNamesRetained'])

    def test_client_failure_cleans_exact_ephemeral_id(self):
        runner=FakeRunner(failure=True)
        with self.assertRaisesRegex(m.Stop,'DUMMY_CLIENT_FAILURE'): m.observe_catalog(self.binding(),runner)
        self.assertEqual(runner.calls[-1][0],['docker','rm','--force','a'*64])

    def test_cleanup_failure_cannot_claim_success(self):
        with self.assertRaisesRegex(m.Stop,'CLEANUP_UNCONFIRMED'):
            m.observe_catalog(self.binding(),FakeRunner(cleanup_failure=True))

    def test_catalog_guard_rejects_writer_recovery_wrong_oid_and_powerful_role(self):
        changes=[('read_only','off'),('recovering',True),('version',170006),('database_oid','0'),('role','other')]
        for key,value in changes:
            data=catalog(); data['identity'][key]=value
            with self.subTest(key=key),self.assertRaises(m.Stop): m.summarize(data,self.binding())
        for flag in ['superuser','create_database','create_role','replication','bypass_rls']:
            data=catalog(); data['roles'][0][flag]=True
            with self.subTest(flag=flag),self.assertRaises(m.Stop): m.summarize(data,self.binding())

    def test_row_sentinel_and_unknown_fields_rejected(self):
        for name,count in [('databases',129),('roles',257),('memberships',1025)]:
            data=catalog(); data[name]=[{}]*count
            with self.subTest(name=name),self.assertRaisesRegex(m.Stop,'ROW_BOUND'): m.summarize(data,self.binding())
        data=catalog(); data['password']='must-never-return'
        with self.assertRaises(m.Stop): m.summarize(data,self.binding())

    def test_public_result_has_no_raw_names_credential_or_ca(self):
        result=m.execute(self.env(),FakeRunner(),probe=lambda _:{'verified':True,'hostnameVerified':True})
        output=json.dumps(result)
        for forbidden in ['ops_db','ops_reader','ops_owner','dummy','BEGIN CERTIFICATE','postgresql://']:
            self.assertNotIn(forbidden,output)
        self.assertFalse(result['custodyReady']); self.assertFalse(result['migrationAuthorized'])
        self.assertFalse(result['vendorFilesObserved']); self.assertFalse(result['providerReceiptVerifiedByJob'])

    def test_bounded_runner_output_and_timeout(self):
        with self.assertRaisesRegex(m.Stop,'OUTPUT_BOUND'):
            m.Runner().run([sys.executable,'-c','print("x"*2000)'],maximum=100)
        with self.assertRaisesRegex(m.Stop,'TIMEOUT'):
            m.Runner().run([sys.executable,'-c','import time; time.sleep(2)'],seconds=.2)

    def test_default_mode_is_offline_source_only(self):
        with patch.object(sys,'argv',['observer']),patch.object(m,'execute',side_effect=AssertionError('execution')):
            self.assertEqual(m.main(),0)

if __name__=='__main__': unittest.main()
