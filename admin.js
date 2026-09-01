const adminState = {
  token: new URLSearchParams(window.location.search).get("token") || localStorage.getItem("happyAdminToken") || "",
  orders: [],
  filter: "active",
  firstLoad: true,
  soundEnabled: false,
  knownOrderIds: new Set()
};

const adminMoney = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL"
});

const adminApiBaseUrl = String(window.HAPPY_API_BASE_URL || "").replace(/\/$/, "");

const adminElements = {
  authPanel: document.getElementById("authPanel"),
  adminPanel: document.getElementById("adminPanel"),
  authForm: document.getElementById("authForm"),
  adminToken: document.getElementById("adminToken"),
  authMessage: document.getElementById("authMessage"),
  refreshOrders: document.getElementById("refreshOrders"),
  soundToggle: document.getElementById("soundToggle"),
  logoutAdmin: document.getElementById("logoutAdmin"),
  etaSettingsForm: document.getElementById("etaSettingsForm"),
  pickupEtaMinutes: document.getElementById("pickupEtaMinutes"),
  deliveryEtaMinutes: document.getElementById("deliveryEtaMinutes"),
  etaSettingsMessage: document.getElementById("etaSettingsMessage"),
  filters: document.querySelectorAll("[data-filter]"),
  ordersTitle: document.getElementById("ordersTitle"),
  visibleCount: document.getElementById("visibleCount"),
  ordersList: document.getElementById("ordersList"),
  lastUpdated: document.getElementById("lastUpdated"),
  operationMessage: document.getElementById("operationMessage"),
  newCount: document.getElementById("newCount"),
  preparingCount: document.getElementById("preparingCount"),
  deliveryCount: document.getElementById("deliveryCount"),
  printCount: document.getElementById("printCount"),
  openTotal: document.getElementById("openTotal")
};

const statusLabels = {
  new: "Novo",
  preparing: "Em preparo",
  out_for_delivery: "Saiu para entrega",
  ready_for_pickup: "Pronto para retirada",
  done: "Finalizado",
  canceled: "Cancelado"
};

const filterTitles = {
  active: "Pedidos abertos",
  delivery: "Pedidos para entrega",
  canceled: "Pedidos cancelados",
  all: "Todos os pedidos"
};

initAdmin();

function initAdmin() {
  bindAdminEvents();

  if (adminState.token) {
    adminElements.adminToken.value = adminState.token;
    showPanel();
    loadOrders();
    loadStoreSettings();
  }

  setInterval(() => {
    if (!adminElements.adminPanel.hidden) {
      loadOrders({ silent: true });
    }
  }, 5000);
}

function bindAdminEvents() {
  adminElements.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    adminState.token = adminElements.adminToken.value.trim();
    localStorage.setItem("happyAdminToken", adminState.token);
    showPanel();
    loadOrders();
    loadStoreSettings();
  });

  adminElements.etaSettingsForm.addEventListener("submit", saveStoreSettings);

  adminElements.refreshOrders.addEventListener("click", () => loadOrders());

  adminElements.soundToggle.addEventListener("click", () => {
    adminState.soundEnabled = !adminState.soundEnabled;
    adminElements.soundToggle.textContent = adminState.soundEnabled ? "Som ligado" : "Som desligado";
    adminElements.soundToggle.setAttribute("aria-pressed", String(adminState.soundEnabled));
    if (adminState.soundEnabled) playAlert();
  });

  adminElements.logoutAdmin.addEventListener("click", () => {
    adminState.token = "";
    adminState.orders = [];
    adminState.knownOrderIds = new Set();
    adminState.firstLoad = true;
    localStorage.removeItem("happyAdminToken");
    adminElements.adminPanel.hidden = true;
    adminElements.authPanel.hidden = false;
    adminElements.adminToken.value = "";
  });

  adminElements.filters.forEach((button) => {
    button.addEventListener("click", () => {
      adminState.filter = button.dataset.filter;
      adminElements.filters.forEach((entry) => entry.classList.toggle("is-active", entry === button));
      renderAdmin();
    });
  });

  adminElements.ordersList.addEventListener("click", async (event) => {
    const statusButton = event.target.closest("[data-status]");
    const reprintButton = event.target.closest("[data-reprint]");

    if (statusButton) {
      await updateStatus(statusButton.dataset.orderId, statusButton.dataset.status);
      return;
    }

    if (reprintButton) {
      reprintButton.disabled = true;
      reprintButton.textContent = "Enviando...";
      const sent = await requestReprint(reprintButton.dataset.orderId);
      if (!sent && reprintButton.isConnected) {
        reprintButton.disabled = false;
        reprintButton.textContent = "Reimprimir";
      }
    }
  });
}

function showPanel() {
  adminElements.authPanel.hidden = true;
  adminElements.adminPanel.hidden = false;
  adminElements.authMessage.textContent = "";
}

async function loadStoreSettings() {
  try {
    const response = await fetch(adminApiUrl(`/api/store-settings?token=${encodeURIComponent(adminState.token)}`));
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Não foi possível carregar os prazos.");
    }

    adminElements.pickupEtaMinutes.value = data.settings.pickupEtaMinutes;
    adminElements.deliveryEtaMinutes.value = data.settings.deliveryEtaMinutes;
    adminElements.etaSettingsMessage.textContent = "";
  } catch (error) {
    adminElements.etaSettingsMessage.textContent = error.message;
  }
}

async function saveStoreSettings(event) {
  event.preventDefault();
  adminElements.etaSettingsMessage.textContent = "Salvando...";

  try {
    const response = await fetch(adminApiUrl(`/api/store-settings?token=${encodeURIComponent(adminState.token)}`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        pickupEtaMinutes: Number(adminElements.pickupEtaMinutes.value),
        deliveryEtaMinutes: Number(adminElements.deliveryEtaMinutes.value)
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Não foi possível salvar os prazos.");
    }

    adminElements.pickupEtaMinutes.value = data.settings.pickupEtaMinutes;
    adminElements.deliveryEtaMinutes.value = data.settings.deliveryEtaMinutes;
    adminElements.etaSettingsMessage.textContent = "Prazos atualizados.";
  } catch (error) {
    adminElements.etaSettingsMessage.textContent = error.message;
  }
}

async function loadOrders(options = {}) {
  try {
    const response = await fetch(adminApiUrl(`/api/orders?token=${encodeURIComponent(adminState.token)}`));
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Não foi possível carregar os pedidos.");
    }

    detectNewOrders(data.orders || []);
    adminState.orders = data.orders || [];
    adminElements.lastUpdated.textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    adminElements.authMessage.textContent = "";
    renderAdmin();
  } catch (error) {
    if (!options.silent) {
      adminElements.authMessage.textContent = error.message;
    }
    if (error.message.includes("Token")) {
      adminElements.adminPanel.hidden = true;
      adminElements.authPanel.hidden = false;
    }
  }
}

function detectNewOrders(orders) {
  const incomingIds = orders.map((order) => order.id);
  const hasNewOrder = !adminState.firstLoad && incomingIds.some((id) => !adminState.knownOrderIds.has(id));
  adminState.knownOrderIds = new Set(incomingIds);
  adminState.firstLoad = false;

  if (hasNewOrder && adminState.soundEnabled) {
    playAlert();
  }
}

function renderAdmin() {
  renderSummary();
  renderOrders();
}

function renderSummary() {
  const deliveryOrders = adminState.orders.filter((order) => {
    const status = normalizeStatus(order.status);
    return order.fulfillment?.method === "delivery" && !["done", "canceled"].includes(status);
  });
  const deliverySales = adminState.orders.filter((order) => {
    return order.fulfillment?.method === "delivery" && normalizeStatus(order.status) !== "canceled";
  });

  adminElements.newCount.textContent = countByStatus("new");
  adminElements.preparingCount.textContent = countByStatus("preparing");
  adminElements.deliveryCount.textContent = deliveryOrders.length;
  adminElements.printCount.textContent = adminState.orders.filter((order) => !order.printedAt).length;
  adminElements.openTotal.textContent = adminMoney.format(deliverySales.reduce((sum, order) => sum + Number(order.totals?.total || 0), 0));
}

function renderOrders() {
  const filtered = getFilteredOrders();
  adminElements.ordersTitle.textContent = filterTitles[adminState.filter] || "Pedidos";
  adminElements.visibleCount.textContent = `${filtered.length} ${filtered.length === 1 ? "pedido" : "pedidos"}`;

  if (filtered.length === 0) {
    adminElements.ordersList.className = "orders-list empty-state";
    adminElements.ordersList.textContent = "Nenhum pedido encontrado.";
    return;
  }

  adminElements.ordersList.className = "orders-list";
  adminElements.ordersList.innerHTML = filtered.map(renderOrderCard).join("");
}

function renderOrderCard(order) {
  const status = normalizeStatus(order.status);
  const method = order.fulfillment?.method === "delivery" ? "Entrega" : "Retirada";
  const region = order.fulfillment?.regionName ? ` · ${escapeHtml(order.fulfillment.regionName)}` : "";
  const printLabel = order.printedAt ? "Impresso" : "A imprimir";
  const printClass = order.printedAt ? "is-printed" : "is-pending";
  const phone = order.customer?.phone || "";

  return `
    <article class="order-card" data-status="${escapeAttribute(status)}">
      <div class="order-top">
        <div>
          <span class="order-number">${escapeHtml(order.orderNumber)}</span>
          <time>${formatDate(order.createdAt)}</time>
        </div>
        <div class="badge-stack">
          <span class="status-badge status-${escapeAttribute(status)}">${escapeHtml(statusLabels[status])}</span>
          <span class="print-badge ${printClass}">${printLabel}</span>
        </div>
      </div>

      <div class="customer-line">
        <strong>${escapeHtml(order.customer?.name || "Cliente")}</strong>
        ${phone ? `<a href="https://wa.me/${phone.replace(/\D/g, "")}" target="_blank" rel="noopener">${escapeHtml(phone)}</a>` : ""}
      </div>

      <div class="order-meta">
        <span>${method}${region}</span>
        ${order.customer?.address ? `<span>${escapeHtml(order.customer.address)}</span>` : ""}
        ${order.customer?.reference ? `<span>Ref.: ${escapeHtml(order.customer.reference)}</span>` : ""}
        ${order.fulfillment?.etaMinutes ? `<span>Prazo estimado: ${escapeHtml(order.fulfillment.etaMinutes)} minutos</span>` : ""}
        <span>${escapeHtml(order.payment?.label || "")}</span>
      </div>

      <div class="item-lines">
        ${(order.items || []).map((item) => `
          <div>
            <span>${item.quantity}x ${escapeHtml(item.name)}</span>
            <strong>${adminMoney.format(item.total || 0)}</strong>
          </div>
          ${item.notes ? `<small>Obs.: ${escapeHtml(item.notes)}</small>` : ""}
        `).join("")}
      </div>

      ${order.notes ? `<p class="order-note">Obs. geral: ${escapeHtml(order.notes)}</p>` : ""}

      <div class="order-total">
        <span>Total</span>
        <strong>${adminMoney.format(order.totals?.total || 0)}</strong>
      </div>

      <div class="order-actions">
        ${renderStatusActions(order, status)}
        <button class="secondary-action" type="button" data-order-id="${escapeAttribute(order.id)}" data-reprint="true">Reimprimir</button>
      </div>
    </article>
  `;
}

function renderStatusActions(order, status) {
  if (status === "done" || status === "canceled") {
    return "";
  }

  const isDelivery = order.fulfillment?.method === "delivery";
  const nextTransportStatus = isDelivery ? "out_for_delivery" : "ready_for_pickup";
  const nextTransportLabel = isDelivery ? "Saiu para entrega" : "Pronto para retirada";

  return [
    status !== "preparing" ? actionButton(order.id, "preparing", "Em preparo") : "",
    status !== nextTransportStatus ? actionButton(order.id, nextTransportStatus, nextTransportLabel) : "",
    actionButton(order.id, "done", "Finalizar"),
    actionButton(order.id, "canceled", "Cancelar")
  ].join("");
}

function actionButton(orderId, status, label) {
  return `<button class="secondary-action" type="button" data-order-id="${escapeAttribute(orderId)}" data-status="${escapeAttribute(status)}">${label}</button>`;
}

function getFilteredOrders() {
  return adminState.orders.filter((order) => {
    const status = normalizeStatus(order.status);

    if (adminState.filter === "all") return true;
    if (adminState.filter === "active") return !["done", "canceled"].includes(status);
    if (adminState.filter === "delivery") return order.fulfillment?.method === "delivery" && !["done", "canceled"].includes(status);
    return status === adminState.filter;
  });
}

async function updateStatus(orderId, status) {
  await sendOrderAction(adminApiUrl(`/api/orders/${encodeURIComponent(orderId)}/status?token=${encodeURIComponent(adminState.token)}`), { status });
}

async function requestReprint(orderId) {
  return sendOrderAction(
    adminApiUrl(`/api/orders/${encodeURIComponent(orderId)}/reprint?token=${encodeURIComponent(adminState.token)}`),
    {},
    "Reimpressão enviada para o Kyro Agent."
  );
}

function adminApiUrl(path) {
  return `${adminApiBaseUrl}${path}`;
}

async function sendOrderAction(url, payload, successMessage = "") {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Não foi possível atualizar o pedido.");
    }

    adminElements.operationMessage.textContent = successMessage;
    await loadOrders({ silent: true });
    return true;
  } catch (error) {
    adminElements.operationMessage.textContent = error.message;
    return false;
  }
}

function countByStatus(status) {
  return adminState.orders.filter((order) => normalizeStatus(order.status) === status).length;
}

function normalizeStatus(status) {
  if (status === "printed") return "new";
  return statusLabels[status] ? status : "new";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function playAlert() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, context.currentTime);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.5);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
