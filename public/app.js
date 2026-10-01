const UI_REFRESH_INTERVAL = 3000;
let isDraggingRow = false;
let isEditingSettings = false;
let currentTargetView = localStorage.getItem('targetView') || 'list'; // 'list' | 'card'

document.addEventListener('DOMContentLoaded', () => {
	// 初期表示ビューを反映
	switchTargetView(currentTargetView, false);

	fetchStatus();
	fetchSchedules();
	fetchLogs();

	setInterval(() => {
		if (!isDraggingRow) fetchStatus();
	}, UI_REFRESH_INTERVAL);

	setInterval(fetchLogs, UI_REFRESH_INTERVAL * 2);

	const settingsForm = document.getElementById('settings-form');
	settingsForm.addEventListener('input', () => {
		isEditingSettings = true;
	});
	settingsForm.addEventListener('change', () => {
		isEditingSettings = true;
	});
	settingsForm.addEventListener('submit', handleSaveSettings);

	document.getElementById('device-form').addEventListener('submit', handleSaveDevice);
	document.getElementById('ping-test-form').addEventListener('submit', handleRunPingTest);
});

// ビュー切り替え（リスト <-> カード）
function switchTargetView(viewMode, save = true) {
	currentTargetView = viewMode;
	if (save) {
		localStorage.setItem('targetView', viewMode);
	}

	const listView = document.getElementById('target-list-view');
	const cardView = document.getElementById('target-card-view');
	const btnList = document.getElementById('view-btn-list');
	const btnCard = document.getElementById('view-btn-card');

	if (viewMode === 'card') {
		listView.classList.add('hidden');
		cardView.classList.remove('hidden');
		btnList.classList.remove('active');
		btnCard.classList.add('active');
	} else {
		cardView.classList.add('hidden');
		listView.classList.remove('hidden');
		btnCard.classList.remove('active');
		btnList.classList.add('active');
	}

	// 表示切り替え後にステータス再描画
	fetchStatus();
}

async function openReadmeModal() {
	const modal = document.getElementById('readme-modal');
	const container = document.getElementById('readme-container');
	container.textContent = '読み込み中...';
	modal.classList.add('active');

	try {
		const res = await fetch('/api/readme');
		const data = await res.json();
		if (data.content) {
			container.innerHTML = parseMarkdownToHtml(data.content);
		} else {
			container.textContent = 'README.md の読み込みに失敗しました。';
		}
	} catch (err) {
		container.textContent = `エラー: ${err.message}`;
	}
}

function closeReadmeModal() {
	document.getElementById('readme-modal').classList.remove('active');
}

function parseMarkdownToHtml(md) {
	const escaped = escapeHtml(md);
	return escaped
		.replace(
			/^### (.*$)/gim,
			'<h4 style="margin: 14px 0 6px; font-size: 0.95rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 2px;">$1</h4>',
		)
		.replace(
			/^## (.*$)/gim,
			'<h3 style="margin: 18px 0 8px; font-size: 1.05rem; border-bottom: 2px solid #2563eb; padding-bottom: 4px; color: #2563eb;">$1</h3>',
		)
		.replace(
			/^# (.*$)/gim,
			'<h2 style="margin: 22px 0 10px; font-size: 1.25rem; border-bottom: 2px solid #0f172a; padding-bottom: 6px; color: #0f172a;">$1</h2>',
		)
		.replace(
			/^---$/gim,
			'<hr style="border: none; border-top: 1px solid #cbd5e1; margin: 16px 0;">',
		)
		.replace(/^\* (.*$)/gim, '• $1')
		.replace(
			/```([\s\S]*?)```/g,
			'<pre style="background:#1e293b; color:#38bdf8; padding:12px; border-radius:4px; overflow-x:auto; font-family:monospace; margin:8px 0;">$1</pre>',
		);
}

async function fetchStatus() {
	try {
		const res = await fetch('/api/status');
		const data = await res.json();

		updateSelfStatus(data.self);
		updateSettingsForm(data.settings);
		updateTableAndStats(data.targets, data.settings);
	} catch (err) {
		console.error('Failed to fetch status:', err);
		document.getElementById('self-status-badge').textContent = 'SERVER DOWN';
		document.getElementById('self-status-badge').className = 'badge status-down';
	}
}

function updateSelfStatus(self) {
	const badge = document.getElementById('self-status-badge');
	badge.textContent = 'SYSTEM RUNNING';
	badge.className = 'badge status-up';

	document.getElementById('self-ip').textContent = `${self.ip}:${self.port}`;
	document.getElementById('self-uptime').textContent = `${Math.floor(self.uptimeSeconds / 60)}分`;
	document.getElementById('self-mem').textContent = `${self.freeMemoryMB}/${self.totalMemoryMB} MB`;
	document.getElementById('self-cpu').textContent = self.cpuLoad;
}

function updateSettingsForm(settings) {
	if (isEditingSettings) return;
	if (document.querySelector('#settings-form:focus-within')) return;

	const mode = settings.mode || 'interval';
	selectMonitorMode(mode, false);

	document.getElementById('setting-interval-ms').value = settings.intervalMs || 30000;
	document.getElementById('setting-timeout').value = settings.timeoutMs;
	document.getElementById('setting-retry').value = settings.retryCount;
	document.getElementById('setting-webhooks').value = (settings.defaultWebhookUrls || []).join(
		'\n',
	);
}

function updateTableAndStats(targets, globalSettings) {
	if (isDraggingRow) return;

	let upCount = 0,
		downCount = 0,
		disabledCount = 0;

	// カウント処理
	targets.forEach((t) => {
		if (!t.enabled) disabledCount++;
		else if (t.isAlive === true) upCount++;
		else if (t.isAlive === false) downCount++;
	});

	document.getElementById('stat-total').textContent = targets.length;
	document.getElementById('stat-up').textContent = upCount;
	document.getElementById('stat-down').textContent = downCount;
	document.getElementById('stat-disabled').textContent = disabledCount;

	// ビューモードに応じた描画
	if (currentTargetView === 'card') {
		renderCardView(targets, globalSettings);
	} else {
		renderListView(targets, globalSettings);
	}
}

// 1. リスト表示パターン描画
function renderListView(targets, globalSettings) {
	const tbody = document.getElementById('target-table-body');
	tbody.innerHTML = '';

	targets.forEach((t) => {
		let statusClass = 'status-disabled';
		let statusText = 'DISABLED';

		if (t.enabled) {
			if (t.isAlive === true) {
				statusClass = 'status-up';
				statusText = 'UP';
			} else if (t.isAlive === false) {
				statusClass = 'status-down';
				statusText = 'DOWN';
			} else {
				statusText = 'PENDING';
			}
		}

		const pingSettingText = t.settingsOverride
			? `個別 (${t.settingsOverride.timeoutMs}ms / R:${t.settingsOverride.retryCount})`
			: '標準';

		const timeoutForTest = t.settingsOverride?.timeoutMs || globalSettings?.timeoutMs || 2000;

		const tr = document.createElement('tr');
		tr.className = 'draggable-row';
		tr.setAttribute('draggable', 'true');
		tr.dataset.id = t.id;

		tr.innerHTML = `
      <td><span class="drag-handle" title="ドラッグで並び替え">⋮⋮</span></td>
      <td><span class="badge ${statusClass}">${statusText}</span></td>
      <td><strong>${escapeHtml(t.label)}</strong></td>
      <td><code>${t.ip}</code></td>
      <td>${t.rtt !== null ? t.rtt + ' ms' : '-'}</td>
      <td><small>${pingSettingText}</small></td>
      <td>
        <label class="switch-label">
          <input type="checkbox" ${
						t.enabled ? 'checked' : ''
					} onchange="handleToggleDeviceEnabled('${t.id}', this.checked)">
          <span class="slider"></span>
        </label>
      </td>
      <td>
        <div class="action-buttons">
          <button class="btn-action btn-test" onclick="runTargetRowTest(this, '${
						t.ip
					}', ${timeoutForTest}, '${escapeHtml(t.label)}')">test</button>
          <button class="btn-action btn-edit" onclick='openEditModal(${JSON.stringify(
						t,
					)})'>編集</button>
          <button class="btn-action btn-danger" onclick="deleteDevice('${t.id}')">削除</button>
        </div>
      </td>
    `;
		tbody.appendChild(tr);
	});

	initTableDragAndDrop();
}

// 2. カード表示パターン描画 (4カラム対応)
function renderCardView(targets, globalSettings) {
	const grid = document.getElementById('target-card-grid');
	grid.innerHTML = '';

	targets.forEach((t) => {
		let statusClass = 'status-disabled';
		let statusText = 'DISABLED';

		if (t.enabled) {
			if (t.isAlive === true) {
				statusClass = 'status-up';
				statusText = 'UP';
			} else if (t.isAlive === false) {
				statusClass = 'status-down';
				statusText = 'DOWN';
			} else {
				statusText = 'PENDING';
			}
		}

		const pingSettingText = t.settingsOverride
			? `個別 (${t.settingsOverride.timeoutMs}ms)`
			: '標準';

		const timeoutForTest = t.settingsOverride?.timeoutMs || globalSettings?.timeoutMs || 2000;

		const card = document.createElement('div');
		card.className = 'device-card draggable-row';
		card.setAttribute('draggable', 'true');
		card.dataset.id = t.id;

		card.innerHTML = `
      <div class="device-card-top">
        <div class="card-top-left">
          <span class="drag-handle" title="ドラッグで並び替え">⋮⋮</span>
          <span class="badge ${statusClass}">${statusText}</span>
        </div>
        <label class="switch-label">
          <input type="checkbox" ${
						t.enabled ? 'checked' : ''
					} onchange="handleToggleDeviceEnabled('${t.id}', this.checked)">
          <span class="slider"></span>
        </label>
      </div>

      <div class="device-card-body">
        <div class="device-card-title">${escapeHtml(t.label)}</div>
        <div class="device-card-ip"><code>${t.ip}</code></div>
        <div class="device-card-details">
          <span>応答: <strong>${t.rtt !== null ? t.rtt + ' ms' : '-'}</strong></span>
          <span>設定: <small>${pingSettingText}</small></span>
        </div>
      </div>

      <div class="device-card-bottom">
        <div class="action-buttons">
          <button class="btn-action btn-test" onclick="runTargetRowTest(this, '${
						t.ip
					}', ${timeoutForTest}, '${escapeHtml(t.label)}')">test</button>
          <button class="btn-action btn-edit" onclick='openEditModal(${JSON.stringify(
						t,
					)})'>編集</button>
          <button class="btn-action btn-danger" onclick="deleteDevice('${t.id}')">削除</button>
        </div>
      </div>
    `;
		grid.appendChild(card);
	});

	initCardDragAndDrop();
}

function selectMonitorMode(mode, userAction = true) {
	if (userAction) {
		isEditingSettings = true;
	}

	document.getElementById('setting-mode-select').value = mode;

	const btnInterval = document.getElementById('tab-mode-interval');
	const btnSchedule = document.getElementById('tab-mode-schedule');
	const intervalBox = document.getElementById('mode-interval-box');
	const scheduleBox = document.getElementById('mode-schedule-box');

	if (mode === 'schedule') {
		btnInterval.classList.remove('active');
		btnSchedule.classList.add('active');
		intervalBox.classList.add('hidden');
		scheduleBox.classList.remove('hidden');
	} else {
		btnSchedule.classList.remove('active');
		btnInterval.classList.add('active');
		scheduleBox.classList.add('hidden');
		intervalBox.classList.remove('hidden');
	}
}

// リストD&D制御
let draggedRow = null;

function initTableDragAndDrop() {
	const tbody = document.getElementById('target-table-body');
	if (!tbody) return;

	const rows = tbody.querySelectorAll('tr.draggable-row');

	rows.forEach((row) => {
		row.addEventListener('dragstart', (e) => {
			isDraggingRow = true;
			draggedRow = row;
			row.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', row.dataset.id);
		});

		row.addEventListener('dragend', async () => {
			row.classList.remove('dragging');
			if (draggedRow) {
				const updatedRows = Array.from(tbody.querySelectorAll('tr.draggable-row'));
				const newOrderIds = updatedRows.map((r) => r.dataset.id);
				await saveNewDeviceOrder(newOrderIds);
			}
			draggedRow = null;
			setTimeout(() => {
				isDraggingRow = false;
			}, 500);
		});

		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			const afterElement = getDragAfterElement(tbody, e.clientY);
			if (draggedRow) {
				if (afterElement == null) {
					tbody.appendChild(draggedRow);
				} else {
					tbody.insertBefore(draggedRow, afterElement);
				}
			}
		});
	});
}

// カードD&D制御
function initCardDragAndDrop() {
	const grid = document.getElementById('target-card-grid');
	if (!grid) return;

	const cards = grid.querySelectorAll('.draggable-row');

	cards.forEach((card) => {
		card.addEventListener('dragstart', (e) => {
			isDraggingRow = true;
			draggedRow = card;
			card.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', card.dataset.id);
		});

		card.addEventListener('dragend', async () => {
			card.classList.remove('dragging');
			if (draggedRow) {
				const updatedCards = Array.from(grid.querySelectorAll('.draggable-row'));
				const newOrderIds = updatedCards.map((c) => c.dataset.id);
				await saveNewDeviceOrder(newOrderIds);
			}
			draggedRow = null;
			setTimeout(() => {
				isDraggingRow = false;
			}, 500);
		});

		card.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			const afterCard = getCardDragAfterElement(grid, e.clientX, e.clientY);
			if (draggedRow) {
				if (afterCard == null) {
					grid.appendChild(draggedRow);
				} else {
					grid.insertBefore(draggedRow, afterCard);
				}
			}
		});
	});
}

function getDragAfterElement(container, y) {
	const draggableElements = [...container.querySelectorAll('tr.draggable-row:not(.dragging)')];
	return draggableElements.reduce(
		(closest, child) => {
			const box = child.getBoundingClientRect();
			const offset = y - box.top - box.height / 2;
			if (offset < 0 && offset > closest.offset) {
				return { offset: offset, element: child };
			} else {
				return closest;
			}
		},
		{ offset: Number.NEGATIVE_INFINITY },
	).element;
}

function getCardDragAfterElement(container, x, y) {
	const draggableElements = [...container.querySelectorAll('.draggable-row:not(.dragging)')];
	return draggableElements.reduce(
		(closest, child) => {
			const box = child.getBoundingClientRect();
			const boxCenterX = box.left + box.width / 2;
			const boxCenterY = box.top + box.height / 2;
			const distance = Math.hypot(x - boxCenterX, y - boxCenterY);

			if (closest.element === null || distance < closest.distance) {
				return { distance: distance, element: child };
			} else {
				return closest;
			}
		},
		{ distance: Number.POSITIVE_INFINITY, element: null },
	).element;
}

async function saveNewDeviceOrder(targetIds) {
	try {
		await fetch('/api/targets/reorder', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ targetIds }),
		});
	} catch (err) {
		console.error('Failed to save device order:', err);
	}
}

async function handleToggleDeviceEnabled(id, enabled) {
	try {
		const res = await fetch(`/api/targets/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled }),
		});
		if (res.ok) {
			fetchStatus();
		}
	} catch (err) {
		console.error('Failed to toggle device state:', err);
	}
}

async function fetchSchedules() {
	try {
		const res = await fetch('/api/schedules');
		const data = await res.json();
		renderScheduleList(data.schedules || []);
	} catch (err) {
		console.error('Failed to fetch schedules:', err);
	}
}

async function addScheduleItem() {
	const type = document.getElementById('sch-type-select').value;
	const value = document.getElementById('sch-datetime-picker').value;

	if (!value) {
		alert('日付と時刻を指定してください。');
		return;
	}

	try {
		await fetch('/api/schedules', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type, value }),
		});
		document.getElementById('sch-datetime-picker').value = '';
		fetchSchedules();
	} catch (err) {
		alert('スケジュールの追加に失敗しました。');
	}
}

async function removeScheduleItem(id) {
	try {
		await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
		fetchSchedules();
	} catch (err) {
		alert('スケジュールの削除に失敗しました。');
	}
}

function renderScheduleList(schedules) {
	const ul = document.getElementById('schedule-list');
	ul.innerHTML = '';

	if (schedules.length === 0) {
		ul.innerHTML =
			'<li class="schedule-item"><small style="color:#94a3b8;">登録されているスケジュールはありません</small></li>';
		return;
	}

	schedules.forEach((s) => {
		const li = document.createElement('li');
		li.className = 'schedule-item';

		const tagClass = s.type === 'daily' ? 'sch-tag-daily' : 'sch-tag-once';
		const tagLabel = s.type === 'daily' ? '毎日' : '一度だけ';

		const [datePart, timePart] = s.value.split('T');
		const displayVal =
			s.type === 'daily'
				? `${timePart} (起点: ${datePart.replace(/-/g, '/')})`
				: `${datePart.replace(/-/g, '/')} ${timePart}`;

		li.innerHTML = `
      <div>
        <span class="sch-tag ${tagClass}">${tagLabel}</span>
        <strong>${displayVal}</strong>
      </div>
      <button type="button" class="btn-del-sch" onclick="removeScheduleItem('${s.id}')">✕</button>
    `;
		ul.appendChild(li);
	});
}

async function fetchLogs() {
	try {
		const res = await fetch('/api/logs');
		const data = await res.json();
		document.getElementById('log-container').textContent = data.logs.join('\n');
	} catch (err) {
		console.error('Failed to fetch logs:', err);
	}
}

async function runTargetRowTest(btnElement, ip, timeoutMs, label) {
	const originalText = btnElement.textContent;
	btnElement.disabled = true;
	btnElement.textContent = 'testing...';

	document.getElementById('test-ip').value = ip;
	document.getElementById('test-timeout').value = timeoutMs;

	const resultBox = document.getElementById('test-result');
	resultBox.className = 'test-result-box';
	resultBox.textContent = `[${label}] (${ip}) へ Ping 送信中...`;
	resultBox.classList.remove('hidden');

	try {
		const res = await fetch('/api/ping-test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ip, timeoutMs }),
		});
		const data = await res.json();

		if (data.isAlive) {
			resultBox.className = 'test-result-box success';
			resultBox.textContent = `[${label}] (${ip}) 応答あり (UP): ${data.rtt} ms`;
		} else {
			resultBox.className = 'test-result-box failed';
			resultBox.textContent = `[${label}] (${ip}) 応答なし (DOWN)`;
		}
	} catch (err) {
		resultBox.className = 'test-result-box failed';
		resultBox.textContent = `エラー: ${err.message}`;
	} finally {
		btnElement.disabled = false;
		btnElement.textContent = originalText;
		fetchLogs();
	}
}

async function handleRunPingTest(e) {
	e.preventDefault();
	const ip = document.getElementById('test-ip').value;
	const timeoutMs = document.getElementById('test-timeout').value;

	const resultBox = document.getElementById('test-result');
	const btn = document.getElementById('test-btn');

	btn.disabled = true;
	resultBox.className = 'test-result-box';
	resultBox.textContent = `Ping 送信中: ${ip} ...`;
	resultBox.classList.remove('hidden');

	try {
		const res = await fetch('/api/ping-test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ip, timeoutMs }),
		});
		const data = await res.json();

		if (data.isAlive) {
			resultBox.className = 'test-result-box success';
			resultBox.textContent = `成功 (UP): 応答時間 ${data.rtt} ms`;
		} else {
			resultBox.className = 'test-result-box failed';
			resultBox.textContent = `失敗 (DOWN): 応答なし`;
		}
	} catch (err) {
		resultBox.className = 'test-result-box failed';
		resultBox.textContent = `エラー: ${err.message}`;
	} finally {
		btn.disabled = false;
		fetchLogs();
	}
}

async function handleSaveSettings(e) {
	e.preventDefault();
	const mode = document.getElementById('setting-mode-select').value;
	const webhooksText = document.getElementById('setting-webhooks').value;

	const payload = {
		mode,
		intervalMs: Number(document.getElementById('setting-interval-ms').value) || 30000,
		timeoutMs: Number(document.getElementById('setting-timeout').value),
		retryCount: Number(document.getElementById('setting-retry').value),
		defaultWebhookUrls: webhooksText
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean),
	};

	await fetch('/api/config/settings', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	isEditingSettings = false;
	alert('基本設定を保存しました。');
	fetchStatus();
}

async function handleSaveDevice(e) {
	e.preventDefault();
	const id = document.getElementById('device-id').value;
	const webhooksText = document.getElementById('device-webhooks').value;
	const isCustomPing = document.getElementById('device-custom-ping').checked;

	let settingsOverride = null;
	if (isCustomPing) {
		settingsOverride = {
			timeoutMs: Number(document.getElementById('device-timeout').value) || 2000,
			retryCount: Number(document.getElementById('device-retry').value) || 2,
		};
	}

	const payload = {
		label: document.getElementById('device-label').value,
		ip: document.getElementById('device-ip').value,
		webhookUrls: webhooksText
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean),
		enabled: document.getElementById('device-enabled').checked,
		settingsOverride,
	};

	if (id) {
		await fetch(`/api/targets/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
	} else {
		await fetch('/api/targets', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
	}

	closeModal();
	fetchStatus();
}

async function deleteDevice(id) {
	if (!confirm('この機器を削除しますか？')) return;
	await fetch(`/api/targets/${id}`, { method: 'DELETE' });
	fetchStatus();
}

function toggleCustomPingFields(show) {
	const container = document.getElementById('custom-ping-container');
	if (show) container.classList.remove('hidden');
	else container.classList.add('hidden');
}

function openAddModal() {
	document.getElementById('modal-title').textContent = '機器の追加';
	document.getElementById('device-id').value = '';
	document.getElementById('device-label').value = '';
	document.getElementById('device-ip').value = '';
	document.getElementById('device-webhooks').value = '';
	document.getElementById('device-custom-ping').checked = false;
	toggleCustomPingFields(false);
	document.getElementById('device-timeout').value = '';
	document.getElementById('device-retry').value = '';
	document.getElementById('device-enabled').checked = true;
	document.getElementById('device-modal').classList.add('active');
}

function openEditModal(target) {
	document.getElementById('modal-title').textContent = '機器の編集';
	document.getElementById('device-id').value = target.id;
	document.getElementById('device-label').value = target.label;
	document.getElementById('device-ip').value = target.ip;
	document.getElementById('device-webhooks').value = (target.webhookUrls || []).join('\n');

	if (target.settingsOverride) {
		document.getElementById('device-custom-ping').checked = true;
		toggleCustomPingFields(true);
		document.getElementById('device-timeout').value = target.settingsOverride.timeoutMs;
		document.getElementById('device-retry').value = target.settingsOverride.retryCount;
	} else {
		document.getElementById('device-custom-ping').checked = false;
		toggleCustomPingFields(false);
		document.getElementById('device-timeout').value = '';
		document.getElementById('device-retry').value = '';
	}

	document.getElementById('device-enabled').checked = target.enabled;
	document.getElementById('device-modal').classList.add('active');
}

function closeModal() {
	document.getElementById('device-modal').classList.remove('active');
}

function escapeHtml(str) {
	return str.replace(
		/[&<>"']/g,
		(m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m],
	);
}
