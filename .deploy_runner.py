import sys, paramiko
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST = "167.86.77.174"
USER = "root"
PW = "M123m123"

cmd = sys.stdin.read()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PW, timeout=30, banner_timeout=30)
stdin, stdout, stderr = client.exec_command(cmd, timeout=900)
out = stdout.read().decode(errors="replace")
err = stderr.read().decode(errors="replace")
rc = stdout.channel.recv_exit_status()
sys.stdout.write(out)
if err.strip():
    sys.stdout.write("\n[STDERR]\n" + err)
sys.stdout.write(f"\n__EXIT__={rc}\n")
client.close()
