const fs = require("fs");
const core = require("@actions/core");
const exec = require("./exec");
const Tail = require("tail").Tail;

const run = (callback) => {
  const configFile = core.getInput("config_file", { required: true });
  const username = core.getInput("username");
  const password = core.getInput("password");
  const clientKey = core.getInput("client_key");
  const tlsAuthKey = core.getInput("tls_auth_key");
  const tlsCryptKey = core.getInput("tls_crypt_key");
  const tlsCryptV2Key = core.getInput("tls_crypt_v2_key");
  const echoConfig = core.getInput("echo_config");
  const testConnection = core.getInput("test_connection") || "true";

  if (!fs.existsSync(configFile)) {
    throw new Error(`config file '${configFile}' not found`);
  }

  // 1. Read and parse the original config file
  const originalConfig = fs.readFileSync(configFile, 'utf8');

  // Extract IP and port from the config file
  let vpnIp = '';
  let vpnPort = '';

  // Parse the remote line to get IP and port
  const remoteMatch = originalConfig.match(/^remote\s+(\S+)\s+(\d+)/m);
  if (remoteMatch) {
    vpnIp = remoteMatch[1];
    vpnPort = remoteMatch[2];
    core.info(`Found VPN server: ${vpnIp}:${vpnPort}`);
  } else {
    core.warning('No remote server found in config file');
  }

  // Set outputs for IP and port so they can be used in subsequent steps
  core.setOutput('vpn_ip', vpnIp);
  core.setOutput('vpn_port', vpnPort);

  let modifiedConfig = originalConfig + '\n# ----- modified by action -----\n';

  // Write the modified config back to file
  fs.writeFileSync(configFile, modifiedConfig);

  // username & password auth
  if (username && password) {
    fs.appendFileSync(configFile, "auth-user-pass up.txt\n");
    fs.writeFileSync("up.txt", [username, password].join("\n"), { mode: 0o600 });
  }

  // client certificate auth
  if (clientKey) {
    fs.appendFileSync(configFile, "key client.key\n");
    fs.writeFileSync("client.key", clientKey, { mode: 0o600 });
  }

  if (tlsAuthKey) {
    fs.appendFileSync(configFile, "tls-auth ta.key 1\n");
    fs.writeFileSync("ta.key", tlsAuthKey, { mode: 0o600 });
  } else {
    // Add this as a fallback if tlsAuthKey is not provided
    fs.appendFileSync(configFile, "tls-client\n");
    fs.appendFileSync(configFile, "remote-cert-tls server\n");
  }

  if (tlsCryptKey) {
    fs.appendFileSync(configFile, "tls-crypt tc.key 1\n");
    fs.writeFileSync("tc.key", tlsCryptKey, { mode: 0o600 });
  }

  if (tlsCryptV2Key) {
    fs.appendFileSync(configFile, "tls-crypt-v2 tcv2.key 1\n");
    fs.writeFileSync("tcv2.key", tlsCryptV2Key, { mode: 0o600 });
  }

  fs.appendFileSync(configFile, "data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305\n");
  fs.appendFileSync(configFile, "data-ciphers-fallback AES-256-CBC\n");
  fs.appendFileSync(configFile, "nobind\n");
  fs.appendFileSync(configFile, "persist-key\n");
  fs.appendFileSync(configFile, "persist-tun\n");
  fs.appendFileSync(configFile, "comp-lzo no\n");
  fs.appendFileSync(configFile, "verb 3\n");
  fs.appendFileSync(configFile, "connect-retry 5\n");
  fs.appendFileSync(configFile, "connect-retry-max 10\n");

  if (echoConfig === "true") {
    core.info("========== begin configuration ==========");
    core.info(fs.readFileSync(configFile, "utf8"));
    core.info("=========== end configuration ===========");
  }

  // 2. Run openvpn
  fs.writeFileSync("openvpn.log", "");
  const tail = new Tail("openvpn.log");

  // Test connection to the VPN IP
  if (testConnection === "true" && vpnIp) {
    testVpnConnection(vpnIp, vpnPort);
  }

  try {
    exec(`sudo openvpn --config ${configFile} --daemon --log openvpn.log --writepid openvpn.pid`);
  } catch (error) {
    core.error(fs.readFileSync("openvpn.log", "utf8"));
    tail.unwatch();
    throw error;
  }

  tail.on("line", (data) => {
    core.info(data);
    if (data.includes("Initialization Sequence Completed")) {
      tail.unwatch();
      clearTimeout(timer);
      const pid = fs.readFileSync("openvpn.pid", "utf8").trim();
      core.info(`VPN connected successfully. Daemon PID: ${pid}`);

      // // Test connection to the VPN IP
      // if (testConnection === "true" && vpnIp) {
      //   testVpnConnection(vpnIp, vpnPort);
      // }

      callback(pid);
    }
  });

  const timer = setTimeout(() => {
    core.setFailed("VPN connection failed.");
    tail.unwatch();
  }, 60 * 1000);
};

// Function to test connection to VPN IP
function testVpnConnection(ip, port) {
  core.info(`Testing connection to VPN server: ${ip}:${port}`);

  try {
    // Test with ping (if ICMP is allowed)
    core.info("Testing ping connectivity...");
    const pingResult = exec(`ping -c 4 -W 2 ${ip}`, { encoding: 'utf8' });
    core.info(`Ping test result:\n${pingResult}`);
  } catch (error) {
    core.warning(`Connection test failed: ${error.message}`);
  }
  try {
    // Test with netcat (UDP connectivity)
    core.info("Testing UDP connectivity with netcat...");
    const ncResult = exec(`echo "" | timeout 15 nc -zvu ${ip} ${port}`, { encoding: 'utf8' });
    core.info(`Netcat UDP test result:\n${ncResult}`);
  } catch (error) {
    core.warning(`Netcat UDP connection test failed: ${error.message}`);
  }
  try {
    // Test UDP connectivity to the port
    core.info(`Testing UDP connectivity to port ${port}...`);
    const timeout = 10000; // 10 seconds timeout

    const dgram = require('dgram');
    const socket = dgram.createSocket('udp4');

    // Set timeout
    const timeoutId = setTimeout(() => {
      core.warning(`Timeout waiting for UDP response from ${ip}:${port}`);
      socket.close();
    }, timeout);

    socket.on('message', (msg, rinfo) => {
      clearTimeout(timeoutId);
      core.info(`✓ Received UDP response from ${rinfo.address}:${rinfo.port}`);
      socket.close();
    });

    socket.on('error', (error) => {
      clearTimeout(timeoutId);
      core.warning(`UDP socket error: ${error.message}`);
      socket.close();
    });

    socket.on('listening', () => {
      // Send a test packet (empty payload)
      const message = Buffer.from('');
      socket.send(message, 0, message.length, port, ip, (err) => {
        if (err) {
          core.warning(`Failed to send UDP packet: ${err.message}`);
          socket.close();
        }
      });
    });

    // Bind to a random local port
    socket.bind();

  } catch (error) {
    core.warning(`UDP connection test failed: ${error.message}`);
  }
}

module.exports = run;
