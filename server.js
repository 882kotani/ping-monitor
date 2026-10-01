const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const PORT = 50002;
const HOST = 'localhost';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');
const README_PATH = path.join(__dirname, 'README.md'); // READMEパス
const LOG_DIR = path.join(__dirname, 'log');
const LOG_FILE = path.join(LOG_DIR, 'monitor.log');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let deviceStatuses = {};
let monitorTimer = null;
let executedOnceSchedules = new Set();

async function writeLog(message) {
	try {
		await fs.mkdir(LOG_DIR, { recursive: true });
		const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
		const logLine = `[${timestamp}] ${message}\n`;
		await fs.appendFile(LOG_FILE, logLine, 'utf8');
	} catch (err) {
		console.error('Failed to write log:', err);
	}
}

async function loadConfig() {
	const data = await fs.readFile(CONFIG_PATH, 'utf8');
	return JSON.parse(data);
}

async function saveConfig(config) {
	await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

async function loadSchedules() {
	try {
		const data = await fs.readFile(SCHEDULES_PATH, 'utf8');
		return JSON.parse(data);
	} catch (err) {
		return [];
	}
}

async function saveSchedules(schedules) {
	await fs.writeFile(SCHEDULES_PATH, JSON.stringify(schedules, null, 2), 'utf8');
}

function executePing(ip, timeoutMs) {
	return new Promise((resolve) => {
		const platform = process.platform;
		let cmd = '';

		if (platform === 'win32') {
			cmd = `ping -n 1 -w ${timeoutMs} ${ip}`;
		} else if (platform === 'darwin') {
			cmd = `ping -c 1 -W ${timeoutMs} ${ip}`;
		} else {
			const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
			cmd = `ping -c 1 -W ${timeoutSec} ${ip}`;
		}

		const startTime = Date.now();

		exec(cmd, { encoding: 'utf8' }, (error, stdout, stderr) => {
			const duration = Date.now() - startTime;
			const output = ((stdout || '') + (stderr || '')).toLowerCase();

			let isAlive = false;
			if (!error) {
				if (platform === 'win32') {
					isAlive =
						(output.includes('ttl=') || output.includes('bytes=')) && !output.includes('100%');
				} else {
					isAlive = output.includes('ttl=') || output.includes('bytes from');
				}
			}

			resolve({
				isAlive,
				rtt: isAlive ? duration : null,
			});
		});
	});
}

async function pingWithRetry(ip, timeoutMs, retryCount) {
	for (let i = 0; i <= retryCount; i++) {
		const res = await executePing(ip, timeoutMs);
		if (res.isAlive) return res;
		if (i < retryCount) {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	return { isAlive: false, rtt: null };
}

async function sendWebhooks(urls, payload) {
	if (!urls || urls.length === 0) return;
	const promises = urls.map(async (url) => {
		if (!url.trim()) return;
		try {
			await fetch(url.trim(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
		} catch (err) {
			await writeLog(`[ERROR] Webhook failed (${url}): ${err.message}`);
		}
	});
	await Promise.allSettled(promises);
}

async function runMonitoring() {
	let config;
	try {
		config = await loadConfig();
	} catch (err) {
		await writeLog(`[ERROR] Failed to load config: ${err.message}`);
		return;
	}

	const { settings, targets } = config;
	const enabledTargets = targets.filter((t) => t.enabled);

	await writeLog(
		`--- Monitoring Cycle Started [Mode: ${settings.mode}] (${enabledTargets.length}/${targets.length} targets active) ---`,
	);

	const BATCH_SIZE = 10;
	for (let i = 0; i < enabledTargets.length; i += BATCH_SIZE) {
		const batch = enabledTargets.slice(i, i + BATCH_SIZE);

		const pingPromises = batch.map(async (target) => {
			const prevStatus = deviceStatuses[target.id]?.isAlive;
			const timeoutMs = target.settingsOverride?.timeoutMs || settings.timeoutMs;
			const retryCount =
				target.settingsOverride?.retryCount !== undefined
					? target.settingsOverride.retryCount
					: settings.retryCount;

			const result = await pingWithRetry(target.ip, timeoutMs, retryCount);
			const now = new Date().toISOString();
			const isStateChanged = prevStatus !== undefined && prevStatus !== result.isAlive;

			deviceStatuses[target.id] = {
				id: target.id,
				label: target.label,
				ip: target.ip,
				enabled: target.enabled,
				isAlive: result.isAlive,
				rtt: result.rtt,
				lastChecked: now,
			};

			const targetWebhooks =
				target.webhookUrls && target.webhookUrls.length > 0
					? target.webhookUrls
					: settings.defaultWebhookUrls;

			if (!result.isAlive) {
				await writeLog(`[DOWN] ${target.label} (${target.ip}) - No Ping response.`);
				if (isStateChanged || prevStatus === undefined) {
					const message = `【死活監視アラート】\n対象: ${target.label} (${
						target.ip
					})\n状態: 応答なし (DOWN)\n確認日時: ${new Date().toLocaleString(
						'ja-JP',
					)}\nダッシュボード: http://${HOST}:${PORT}/`;
					await sendWebhooks(targetWebhooks, { text: message });
				}
			} else {
				if (isStateChanged && prevStatus === false) {
					await writeLog(
						`[RECOVERED] ${target.label} (${target.ip}) - Responded in ${result.rtt}ms.`,
					);
					const message = `【死活監視復旧】\n対象: ${target.label} (${
						target.ip
					})\n状態: 復旧 (UP)\n応答時間: ${result.rtt}ms\n確認日時: ${new Date().toLocaleString(
						'ja-JP',
					)}`;
					await sendWebhooks(targetWebhooks, { text: message });
				} else {
					await writeLog(`[OK] ${target.label} (${target.ip}) - RTT: ${result.rtt}ms`);
				}
			}
		});

		await Promise.all(pingPromises);
	}

	await writeLog(`--- Monitoring Cycle Completed ---`);
}

async function checkScheduleAndRun() {
	try {
		const config = await loadConfig();
		if (config.settings.mode !== 'schedule') return;

		const now = new Date();
		const currentDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
			2,
			'0',
		)}-${String(now.getDate()).padStart(2, '0')}`;
		const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(
			now.getMinutes(),
		).padStart(2, '0')}`;
		const currentDateTimeStr = `${currentDateStr}T${currentTimeStr}`;

		const schedules = await loadSchedules();
		let shouldRun = false;

		for (const item of schedules) {
			const [startDateStr, targetTimeStr] = item.value.split('T');
			const execKey = `${item.id}_${currentDateTimeStr}`;

			if (item.type === 'daily') {
				if (currentDateStr >= startDateStr && currentTimeStr === targetTimeStr) {
					if (!executedOnceSchedules.has(execKey)) {
						executedOnceSchedules.add(execKey);
						shouldRun = true;
					}
				}
			} else if (item.type === 'once') {
				if (currentDateTimeStr === item.value) {
					if (!executedOnceSchedules.has(execKey)) {
						executedOnceSchedules.add(execKey);
						shouldRun = true;
					}
				}
			}
		}

		if (shouldRun) {
			await runMonitoring();
		}
	} catch (err) {
		console.error('Schedule check error:', err);
	}
}

async function restartMonitorScheduler() {
	if (monitorTimer) clearInterval(monitorTimer);
	const config = await loadConfig();
	const { mode, intervalMs } = config.settings;

	if (mode === 'schedule') {
		checkScheduleAndRun();
		monitorTimer = setInterval(checkScheduleAndRun, 10000);
	} else {
		const interval = Number(intervalMs) || 30000;
		runMonitoring();
		monitorTimer = setInterval(runMonitoring, interval);
	}
}

// 【新規】README.md 取得 API
app.get('/api/readme', async (req, res) => {
	try {
		const content = await fs
			.readFile(README_PATH, 'utf8')
			.catch(() => 'README.md ファイルが見つかりません。');
		res.json({ content });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get('/api/schedules', async (req, res) => {
	try {
		const schedules = await loadSchedules();
		res.json({ schedules });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post('/api/schedules', async (req, res) => {
	try {
		const { type, value } = req.body;
		if (!type || !value) return res.status(400).json({ error: 'Type and value are required.' });

		const schedules = await loadSchedules();
		const newItem = { id: `sch-${Date.now()}`, type, value };
		schedules.push(newItem);

		await saveSchedules(schedules);
		await writeLog(`[SCHEDULE] Added schedule: ${type} - ${value}`);
		res.json({ success: true, schedule: newItem });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.delete('/api/schedules/:id', async (req, res) => {
	try {
		const { id } = req.params;
		let schedules = await loadSchedules();
		schedules = schedules.filter((s) => s.id !== id);

		await saveSchedules(schedules);
		await writeLog(`[SCHEDULE] Deleted schedule ID: ${id}`);
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post('/api/ping-test', async (req, res) => {
	try {
		const { ip, timeoutMs } = req.body;
		if (!ip) return res.status(400).json({ error: 'IP address is required.' });

		const timeout = Number(timeoutMs) || 2000;
		const result = await executePing(ip, timeout);

		await writeLog(
			`[TEST PING] Tested ${ip} - Result: ${result.isAlive ? `UP (${result.rtt}ms)` : 'DOWN'}`,
		);
		res.json({ ip, ...result });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get('/api/status', async (req, res) => {
	try {
		const config = await loadConfig();
		const selfStatus = {
			ip: HOST,
			port: PORT,
			status: 'UP',
			uptimeSeconds: Math.floor(process.uptime()),
			freeMemoryMB: Math.floor(os.freemem() / (1024 * 1024)),
			totalMemoryMB: Math.floor(os.totalmem() / (1024 * 1024)),
			cpuLoad: os.loadavg()[0].toFixed(2),
		};

		const list = config.targets.map((t) => {
			const dynStatus = deviceStatuses[t.id] || {};
			return {
				id: t.id,
				label: t.label,
				ip: t.ip,
				enabled: t.enabled,
				isAlive: t.enabled ? dynStatus.isAlive ?? null : null,
				rtt: t.enabled ? dynStatus.rtt ?? null : null,
				lastChecked: t.enabled ? dynStatus.lastChecked ?? null : null,
				webhookUrls: t.webhookUrls || [],
				settingsOverride: t.settingsOverride || null,
			};
		});

		res.json({ self: selfStatus, settings: config.settings, targets: list });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post('/api/config/settings', async (req, res) => {
	try {
		const config = await loadConfig();
		const { mode, intervalMs, timeoutMs, retryCount, defaultWebhookUrls } = req.body;

		if (mode !== undefined) config.settings.mode = mode;
		if (intervalMs !== undefined) config.settings.intervalMs = Number(intervalMs);
		if (timeoutMs !== undefined) config.settings.timeoutMs = Number(timeoutMs);
		if (retryCount !== undefined) config.settings.retryCount = Number(retryCount);
		if (defaultWebhookUrls !== undefined) {
			config.settings.defaultWebhookUrls = Array.isArray(defaultWebhookUrls)
				? defaultWebhookUrls
				: defaultWebhookUrls
						.split('\n')
						.map((s) => s.trim())
						.filter(Boolean);
		}

		await saveConfig(config);
		await restartMonitorScheduler();
		res.json({ success: true, settings: config.settings });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post('/api/targets', async (req, res) => {
	try {
		const { label, ip, enabled, webhookUrls, settingsOverride } = req.body;
		if (!label || !ip) return res.status(400).json({ error: 'Label and IP are required.' });

		const config = await loadConfig();
		if (config.targets.length >= 100) return res.status(400).json({ error: 'Limit reached.' });

		const newTarget = {
			id: `target-${Date.now()}`,
			label,
			ip,
			enabled: enabled !== undefined ? enabled : true,
			webhookUrls: Array.isArray(webhookUrls) ? webhookUrls : [],
			settingsOverride: settingsOverride || null,
		};

		config.targets.push(newTarget);
		await saveConfig(config);
		await writeLog(`[CONFIG] Added device: ${label} (${ip})`);

		runMonitoring();
		res.json({ success: true, target: newTarget });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post('/api/targets/reorder', async (req, res) => {
	try {
		const { targetIds } = req.body;
		if (!Array.isArray(targetIds)) {
			return res.status(400).json({ error: 'targetIds array is required.' });
		}

		const config = await loadConfig();
		const targetMap = new Map(config.targets.map((t) => [t.id, t]));
		const newTargets = [];

		targetIds.forEach((id) => {
			if (targetMap.has(id)) {
				newTargets.push(targetMap.get(id));
				targetMap.delete(id);
			}
		});

		targetMap.forEach((t) => newTargets.push(t));

		config.targets = newTargets;
		await saveConfig(config);
		await writeLog(`[CONFIG] Reordered target devices.`);

		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.put('/api/targets/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const { label, ip, enabled, webhookUrls, settingsOverride } = req.body;
		const config = await loadConfig();

		const target = config.targets.find((t) => t.id === id);
		if (!target) return res.status(404).json({ error: 'Target not found.' });

		if (label !== undefined) target.label = label;
		if (ip !== undefined) target.ip = ip;
		if (enabled !== undefined) target.enabled = Boolean(enabled);
		if (webhookUrls !== undefined) target.webhookUrls = webhookUrls;
		if (settingsOverride !== undefined) target.settingsOverride = settingsOverride;

		if (deviceStatuses[id]) {
			deviceStatuses[id].enabled = target.enabled;
			if (!target.enabled) {
				deviceStatuses[id].isAlive = null;
				deviceStatuses[id].rtt = null;
			}
		}

		await saveConfig(config);
		await writeLog(
			`[CONFIG] Updated device: ${target.label} (${target.ip}) [Enabled: ${target.enabled}]`,
		);

		res.json({ success: true, target });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.delete('/api/targets/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const config = await loadConfig();
		config.targets = config.targets.filter((t) => t.id !== id);
		delete deviceStatuses[id];

		await saveConfig(config);
		await writeLog(`[CONFIG] Removed device ID: ${id}`);
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get('/api/logs', async (req, res) => {
	try {
		const data = await fs.readFile(LOG_FILE, 'utf8').catch(() => '');
		const lines = data.trim().split('\n');
		res.json({ logs: lines.slice(-150).reverse() });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.listen(PORT, HOST, async () => {
	console.log(`Server running at http://${HOST}:${PORT}/`);
	await writeLog(`[SYSTEM] Server started at http://${HOST}:${PORT}/`);
	restartMonitorScheduler();
});
