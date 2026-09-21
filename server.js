const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3030);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const STORE_SETTINGS_FILE = path.join(DATA_DIR, "store-settings.json");
const MENU_FILE = path.join(DATA_DIR, "menu.json");

const rawStoreConfig = readJson(path.join(ROOT, "config", "store.json"));
const storeConfig = {
  ...rawStoreConfig,
  storeToken: process.env.STORE_TOKEN || rawStoreConfig.storeToken
};
const defaultMenuConfig = readJson(path.join(ROOT, "config", "menu.json"));
const supabaseConfig = {
  url: String(process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  serviceRoleKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || ""),
  table: String(process.env.SUPABASE_ORDERS_TABLE || "happy_orders"),
  settingsTable: String(process.env.SUPABASE_SETTINGS_TABLE || "happy_store_settings")
};
const useSupabase = Boolean(supabaseConfig.url && supabaseConfig.serviceRoleKey);
const cashWindowConfig = {
  timeZone: process.env.STORE_TIME_ZONE || "America/Sao_Paulo",
  resetHour: Number(process.env.ORDER_RESET_HOUR || 16)
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const orderStatusLabels = {
  new: "Novo",
  preparing: "Em preparo",
  out_for_delivery: "Saiu para entrega",
  ready_for_pickup: "Pronto para retirada",
  done: "Finalizado",
  canceled: "Cancelado"
};

if (!useSupabase) ensureDataFile();

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (requestUrl.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        store: storeConfig.storeName,
        storage: useSupabase ? "supabase" : "local",
        retention: {
          mode: "current_cash_window",
          resetHour: cashWindowConfig.resetHour,
          timeZone: cashWindowConfig.timeZone
        }
      });
      return;
    }

    if (requestUrl.pathname === "/api/config" && req.method === "GET") {
      const [operationalSettings, menu] = await Promise.all([
        readStoreSettings(),
        readMenu()
      ]);
      sendJson(res, 200, {
        store: { ...publicStoreConfig(), ...operationalSettings },
        menu: publicMenuConfig(menu)
      });
      return;
    }

    if (requestUrl.pathname === "/api/menu" && req.method === "GET") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      sendJson(res, 200, { menu: await readMenu() });
      return;
    }

    if (requestUrl.pathname === "/api/menu" && req.method === "POST") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      const menu = await writeMenu(await readRequestBody(req));
      sendJson(res, 200, { ok: true, menu });
      return;
    }

    if (requestUrl.pathname === "/api/store-settings" && req.method === "GET") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      sendJson(res, 200, { settings: await readStoreSettings() });
      return;
    }

    if (requestUrl.pathname === "/api/store-settings" && req.method === "POST") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      const payload = await readRequestBody(req);
      const settings = normalizeStoreSettings(payload);
      await writeStoreSettings(settings);
      sendJson(res, 200, { ok: true, settings });
      return;
    }

    if (requestUrl.pathname === "/api/orders" && req.method === "POST") {
      const payload = await readRequestBody(req);
      const order = await createOrder(payload);
      await appendOrder(order);
      sendJson(res, 201, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        totals: order.totals,
        fulfillment: order.fulfillment,
        whatsappText: order.whatsappText
      });
      return;
    }

    if (requestUrl.pathname === "/api/orders" && req.method === "GET") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      const orders = await readOrders();
      sendJson(res, 200, { orders: orders.map(withOrderDefaults).slice().reverse() });
      return;
    }

    if (requestUrl.pathname === "/api/orders/pending" && req.method === "GET") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      const orders = await readOrders();
      const pending = orders
        .filter((order) => shouldPrintOrder(order))
        .map(prepareOrderForPrintAgent);
      sendJson(res, 200, { orders: pending });
      return;
    }

    const printedMatch = requestUrl.pathname.match(/^\/api\/orders\/([^/]+)\/printed$/);
    if (printedMatch && req.method === "POST") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      const updated = await markPrinted(printedMatch[1]);
      if (!updated) {
        sendJson(res, 404, { error: "Pedido não encontrado." });
        return;
      }

      sendJson(res, 200, { ok: true, order: updated });
      return;
    }

    const statusMatch = requestUrl.pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
    if (statusMatch && req.method === "POST") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      const payload = await readRequestBody(req);
      const updated = await updateOrderStatus(statusMatch[1], payload.status);
      if (!updated) {
        sendJson(res, 404, { error: "Pedido não encontrado." });
        return;
      }

      sendJson(res, 200, { ok: true, order: withOrderDefaults(updated) });
      return;
    }

    const reprintMatch = requestUrl.pathname.match(/^\/api\/orders\/([^/]+)\/reprint$/);
    if (reprintMatch && req.method === "POST") {
      if (!isAuthorized(req, requestUrl)) {
        sendJson(res, 401, { error: "Token da loja inválido." });
        return;
      }

      const updated = await requestReprint(reprintMatch[1]);
      if (!updated) {
        sendJson(res, 404, { error: "Pedido não encontrado." });
        return;
      }

      sendJson(res, 200, { ok: true, order: withOrderDefaults(updated) });
      return;
    }

    serveStaticFile(requestUrl.pathname, res);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { error: error.message || "Erro interno." });
  }
});

server.listen(PORT, () => {
  console.log(`${storeConfig.storeName} rodando em http://localhost:${PORT}`);
});

function readJson(filePath) {
  return JSON.parse(stripJsonBom(fs.readFileSync(filePath, "utf8")));
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, "[]\n", "utf8");
  }

  if (!fs.existsSync(STORE_SETTINGS_FILE)) {
    fs.writeFileSync(STORE_SETTINGS_FILE, `${JSON.stringify(defaultStoreSettings(), null, 2)}\n`, "utf8");
  }

  if (!fs.existsSync(MENU_FILE)) {
    fs.writeFileSync(MENU_FILE, `${JSON.stringify(normalizeMenu(defaultMenuConfig), null, 2)}\n`, "utf8");
  }
}

function defaultStoreSettings() {
  return {
    pickupEtaMinutes: normalizeEtaMinutes(storeConfig.pickupEtaMinutes, 30),
    deliveryEtaMinutes: normalizeEtaMinutes(storeConfig.deliveryEtaMinutes, 50)
  };
}

function normalizeStoreSettings(input = {}) {
  const defaults = defaultStoreSettings();
  return {
    pickupEtaMinutes: normalizeEtaMinutes(input.pickupEtaMinutes, defaults.pickupEtaMinutes),
    deliveryEtaMinutes: normalizeEtaMinutes(input.deliveryEtaMinutes, defaults.deliveryEtaMinutes)
  };
}

function normalizeEtaMinutes(value, fallback) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes)) return fallback;
  return Math.min(240, Math.max(5, minutes));
}

async function readStoreSettings() {
  if (useSupabase) {
    try {
      const rows = await supabaseRequest(`/${encodeURIComponent(supabaseConfig.settingsTable)}?id=eq.default&select=settings&limit=1`);
      return normalizeStoreSettings(rows?.[0]?.settings || {});
    } catch (error) {
      console.warn(`Configuração de prazos indisponível: ${error.message}`);
      return defaultStoreSettings();
    }
  }

  ensureDataFile();
  return normalizeStoreSettings(readJson(STORE_SETTINGS_FILE));
}

async function writeStoreSettings(settings) {
  const normalized = normalizeStoreSettings(settings);

  if (useSupabase) {
    await supabaseRequest(`/${encodeURIComponent(supabaseConfig.settingsTable)}`, {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        id: "default",
        settings: normalized,
        updated_at: new Date().toISOString()
      })
    });
    return;
  }

  ensureDataFile();
  fs.writeFileSync(STORE_SETTINGS_FILE, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function readMenu() {
  if (useSupabase) {
    try {
      const rows = await supabaseRequest(`/${encodeURIComponent(supabaseConfig.settingsTable)}?id=eq.menu&select=settings&limit=1`);
      return normalizeMenu(rows?.[0]?.settings || defaultMenuConfig);
    } catch (error) {
      console.warn(`Cardápio online indisponível: ${error.message}`);
      return normalizeMenu(defaultMenuConfig);
    }
  }

  ensureDataFile();
  return normalizeMenu(readJson(MENU_FILE));
}

async function writeMenu(input) {
  const menu = normalizeMenu(input);

  if (useSupabase) {
    await supabaseRequest(`/${encodeURIComponent(supabaseConfig.settingsTable)}`, {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        id: "menu",
        settings: menu,
        updated_at: new Date().toISOString()
      })
    });
    return menu;
  }

  ensureDataFile();
  fs.writeFileSync(MENU_FILE, `${JSON.stringify(menu, null, 2)}\n`, "utf8");
  return menu;
}

function normalizeMenu(input = {}) {
  if (!Array.isArray(input.categories)) {
    throw Object.assign(new Error("Cardápio inválido: informe as categorias."), { statusCode: 400 });
  }

  const usedCategoryIds = new Set();
  const usedItemIds = new Set();
  const categories = input.categories.slice(0, 30).map((category, categoryIndex) => {
    const name = cleanText(category?.name, 80);
    if (!name) {
      throw Object.assign(new Error(`Informe o nome da categoria ${categoryIndex + 1}.`), { statusCode: 400 });
    }

    const id = uniqueMenuId(category?.id || name, `categoria-${categoryIndex + 1}`, usedCategoryIds);
    const rawItems = Array.isArray(category?.items) ? category.items : [];
    const items = rawItems.slice(0, 300).map((item, itemIndex) => {
      const itemName = cleanText(item?.name, 120);
      const price = Number(item?.price);

      if (!itemName) {
        throw Object.assign(new Error(`Informe o nome do produto ${itemIndex + 1} em ${name}.`), { statusCode: 400 });
      }
      if (!Number.isFinite(price) || price < 0 || price > 9999) {
        throw Object.assign(new Error(`Informe um preço válido para ${itemName}.`), { statusCode: 400 });
      }

      return {
        id: uniqueMenuId(item?.id || itemName, `produto-${categoryIndex + 1}-${itemIndex + 1}`, usedItemIds),
        name: itemName,
        description: cleanText(item?.description, 500),
        price: roundMoney(price),
        available: item?.available !== false
      };
    });

    return {
      id,
      name,
      enabled: category?.enabled !== false,
      items
    };
  });

  if (categories.length === 0) {
    throw Object.assign(new Error("O cardápio precisa ter pelo menos uma categoria."), { statusCode: 400 });
  }

  return { categories };
}

function uniqueMenuId(value, fallback, usedIds) {
  const normalized = String(value || fallback)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
  let candidate = normalized;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${normalized}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

function publicMenuConfig(menu) {
  return {
    categories: menu.categories
      .filter((category) => category.enabled !== false)
      .map((category) => ({
        id: category.id,
        name: category.name,
        items: category.items.filter((item) => item.available !== false)
      }))
      .filter((category) => category.items.length > 0)
  };
}

async function readOrders() {
  if (useSupabase) return readOrdersFromSupabase();
  return readOrdersFromFile();
}

async function appendOrder(order) {
  if (useSupabase) {
    await insertOrderInSupabase(order);
    return;
  }

  const orders = readOrdersFromFile();
  orders.push(order);
  writeOrdersToFile(orders);
}

async function writeOrders(orders) {
  if (useSupabase) {
    await syncOrdersToSupabase(orders);
    return;
  }

  writeOrdersToFile(orders);
}

function readOrdersFromFile() {
  ensureDataFile();
  const orders = JSON.parse(stripJsonBom(fs.readFileSync(ORDERS_FILE, "utf8")));
  const activeOrders = keepOrdersForCurrentCashWindow(orders);

  if (activeOrders.length !== orders.length) {
    writeOrdersToFile(activeOrders);
  }

  return activeOrders;
}

function stripJsonBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function writeOrdersToFile(orders) {
  fs.writeFileSync(ORDERS_FILE, `${JSON.stringify(orders, null, 2)}\n`, "utf8");
}

async function readOrdersFromSupabase() {
  const response = await supabaseRequest(`/${encodeURIComponent(supabaseConfig.table)}?select=id,order_data&order=sequence.asc`);
  const orders = response.map((row) => row.order_data).filter(Boolean);
  const activeOrders = keepOrdersForCurrentCashWindow(orders);

  if (activeOrders.length !== orders.length) {
    const activeIds = new Set(activeOrders.map((order) => order.id));
    const expiredIds = orders.map((order) => order.id).filter((id) => !activeIds.has(id));
    await Promise.all(expiredIds.map(deleteOrderFromSupabase));
  }

  return activeOrders;
}

async function insertOrderInSupabase(order) {
  await supabaseRequest(`/${encodeURIComponent(supabaseConfig.table)}`, {
    method: "POST",
    headers: {
      Prefer: "return=minimal"
    },
    body: JSON.stringify(orderToSupabaseRow(order))
  });
}

async function syncOrdersToSupabase(orders) {
  await Promise.all(orders.map((order) => updateOrderInSupabase(order)));
}

async function updateOrderInSupabase(order) {
  await supabaseRequest(`/${encodeURIComponent(supabaseConfig.table)}?id=eq.${encodeURIComponent(order.id)}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=minimal"
    },
    body: JSON.stringify(orderToSupabaseRow(order))
  });
}

async function deleteOrderFromSupabase(orderId) {
  await supabaseRequest(`/${encodeURIComponent(supabaseConfig.table)}?id=eq.${encodeURIComponent(orderId)}`, {
    method: "DELETE",
    headers: {
      Prefer: "return=minimal"
    }
  });
}

function orderToSupabaseRow(order) {
  return {
    id: order.id,
    sequence: Number(order.sequence || 0),
    order_number: order.orderNumber,
    status: normalizeOrderStatus(order.status),
    printed_at: order.printedAt || null,
    order_data: order,
    updated_at: new Date().toISOString()
  };
}

function keepOrdersForCurrentCashWindow(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return [];

  const now = new Date();
  const allowedDates = new Set([getStoreDateKey(now)]);

  if (getStoreHour(now) < cashWindowConfig.resetHour) {
    allowedDates.add(getStoreDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000)));
  }

  return orders.filter((order) => {
    const orderDate = order.createdAt || order.statusUpdatedAt || new Date().toISOString();
    return allowedDates.has(getStoreDateKey(orderDate));
  });
}

function getStoreDateKey(value) {
  const parts = getStoreDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getStoreHour(value) {
  return Number(getStoreDateParts(value).hour || 0);
}

function getStoreDateParts(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: cashWindowConfig.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${supabaseConfig.url}/rest/v1${pathname}`, {
    ...options,
    headers: {
      apikey: supabaseConfig.serviceRoleKey,
      Authorization: `Bearer ${supabaseConfig.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw Object.assign(new Error(`Erro no banco online: ${message || response.statusText}`), {
      statusCode: 500
    });
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Store-Token");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error("Pedido muito grande."), { statusCode: 413 }));
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(Object.assign(new Error("JSON inválido."), { statusCode: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function publicStoreConfig() {
  const { storeToken, ...safeConfig } = storeConfig;
  return safeConfig;
}

function isAuthorized(req, requestUrl) {
  const token = req.headers["x-store-token"] || requestUrl.searchParams.get("token");
  return token && token === storeConfig.storeToken;
}

function withOrderDefaults(order) {
  const status = normalizeOrderStatus(order.status);
  return {
    ...order,
    status,
    statusLabel: orderStatusLabels[status],
    printed: Boolean(order.printedAt)
  };
}

function normalizeOrderStatus(status) {
  if (status === "printed") return "new";
  return orderStatusLabels[status] ? status : "new";
}

function shouldPrintOrder(order) {
  if (!order || order.printedAt) return false;
  if (order.printStatus === "pending" && order.reprintRequestedAt) return true;
  return normalizeOrderStatus(order.status) === "new";
}

function prepareOrderForPrintAgent(order) {
  if (order.printStatus !== "pending" || !order.reprintRequestedAt) {
    return order;
  }

  // Older Kyro Agent versions only print orders whose status is "new".
  // Keep the real workflow status in storage and normalize it only in this response.
  return {
    ...order,
    status: "new",
    statusLabel: orderStatusLabels.new,
    printedAt: null
  };
}

async function createOrder(payload) {
  const [orders, menu] = await Promise.all([readOrders(), readMenu()]);
  const sequence = getNextSequence(orders);
  const operationalSettings = await readStoreSettings();
  const fulfillment = normalizeFulfillment(payload.fulfillment || {}, operationalSettings);
  const customer = normalizeCustomer(payload.customer || {}, fulfillment);
  const payment = normalizePayment(payload.payment || {});
  const calculated = calculateCart(payload.cart || [], fulfillment, menu);
  const now = new Date().toISOString();

  const order = {
    id: crypto.randomUUID(),
    sequence,
    orderNumber: `${storeConfig.orderPrefix}-${String(sequence).padStart(4, "0")}`,
    storeName: storeConfig.storeName,
    logoPath: storeConfig.logoPath,
    status: "new",
    statusLabel: orderStatusLabels.new,
    statusUpdatedAt: now,
    createdAt: now,
    printedAt: null,
    customer,
    fulfillment,
    payment,
    items: calculated.items,
    totals: calculated.totals,
    notes: cleanText(payload.notes, 600)
  };

  order.printBodyText = buildPrintBodyText(order);
  order.printText = buildPrintText(order);
  order.whatsappText = buildWhatsappText(order);

  return order;
}

function getNextSequence(orders) {
  const highest = orders.reduce((max, order) => Math.max(max, Number(order.sequence || 0)), 0);
  return highest + 1;
}

function normalizeFulfillment(input, operationalSettings = defaultStoreSettings()) {
  const method = input.method === "delivery" ? "delivery" : "pickup";

  if (method === "delivery" && !storeConfig.acceptsDelivery) {
    throw Object.assign(new Error("Entrega indisponível no momento."), { statusCode: 400 });
  }

  if (method === "pickup" && !storeConfig.acceptsPickup) {
    throw Object.assign(new Error("Retirada indisponível no momento."), { statusCode: 400 });
  }

  if (method === "delivery") {
    const region = findDeliveryRegion(input.regionId);

    if (!region) {
      throw Object.assign(new Error("Selecione a região de entrega."), { statusCode: 400 });
    }

    return {
      method,
      label: "Entrega",
      regionId: region.id,
      regionName: region.name,
      deliveryFee: Number(region.fee || 0),
      etaMinutes: operationalSettings.deliveryEtaMinutes
    };
  }

  return {
    method,
    label: "Retirada",
    regionId: "",
    regionName: "",
    deliveryFee: 0,
    etaMinutes: operationalSettings.pickupEtaMinutes
  };
}

function normalizeCustomer(input, fulfillment) {
  const method = fulfillment.method === "delivery" ? "delivery" : "pickup";
  const customer = {
    name: cleanText(input.name, 90) || "Cliente",
    phone: cleanText(input.phone, 40),
    address: cleanText(input.address, 260),
    reference: cleanText(input.reference, 180)
  };

  if (method === "delivery" && !customer.address) {
    throw Object.assign(new Error("Informe o endereço de entrega."), { statusCode: 400 });
  }

  if (!customer.phone) {
    throw Object.assign(new Error("Informe o telefone do cliente."), { statusCode: 400 });
  }

  return customer;
}

function normalizePayment(input) {
  const allowed = new Set(["cash", "card", "pix"]);
  const type = allowed.has(input.type) ? input.type : "card";

  const payment = {
    type,
    label: paymentLabel(type),
    cardKind: "",
    needChange: false,
    changeFor: ""
  };

  if (type === "card") {
    payment.cardKind = input.cardKind === "credit" ? "credit" : "debit";
    payment.label = payment.cardKind === "credit" ? "Cartão crédito" : "Cartão débito";
  }

  if (type === "cash") {
    payment.needChange = Boolean(input.needChange);
    payment.changeFor = payment.needChange ? cleanText(input.changeFor, 40) : "";
    payment.label = payment.needChange ? `Dinheiro com troco para ${payment.changeFor || "valor não informado"}` : "Dinheiro sem troco";
  }

  return payment;
}

function paymentLabel(type) {
  if (type === "cash") return "Dinheiro";
  if (type === "pix") return "Pix";
  return "Cartão";
}

function calculateCart(cart, fulfillment, menu) {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw Object.assign(new Error("Adicione pelo menos um item ao pedido."), { statusCode: 400 });
  }

  const items = cart.map((cartItem) => {
    const menuItem = findMenuItem(cartItem.itemId, menu);
    if (!menuItem) {
      throw Object.assign(new Error("Item do cardápio não encontrado."), { statusCode: 400 });
    }

    const quantity = clampQuantity(cartItem.quantity);
    const unitPrice = Number(menuItem.price);
    const total = roundMoney(unitPrice * quantity);

    return {
      itemId: menuItem.id,
      name: menuItem.name,
      quantity,
      unitPrice,
      total,
      notes: cleanText(cartItem.notes, 220)
    };
  });

  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.total, 0));
  const deliveryFee = fulfillment.method === "delivery" ? Number(fulfillment.deliveryFee || 0) : 0;
  const total = roundMoney(subtotal + deliveryFee);

  return {
    items,
    totals: {
      subtotal,
      deliveryFee,
      total
    }
  };
}

function findMenuItem(itemId, menu) {
  for (const category of menu.categories) {
    if (category.enabled === false) continue;
    const item = category.items.find((entry) => entry.id === itemId && entry.available !== false);
    if (item) return item;
  }

  return null;
}

function findDeliveryRegion(regionId) {
  const regions = Array.isArray(storeConfig.deliveryRegions) ? storeConfig.deliveryRegions : [];
  return regions.find((region) => region.id === regionId) || null;
}

function clampQuantity(value) {
  const quantity = Number.parseInt(value, 10);
  if (!Number.isFinite(quantity) || quantity < 1) return 1;
  return Math.min(quantity, 99);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: storeConfig.currency || "BRL"
  }).format(value).replace(/\u00a0/g, " ");
}

function buildPrintBodyText(order) {
  const lines = [
    `PEDIDO ${order.orderNumber}`,
    formatDateTime(order.createdAt),
    repeat("-", 32),
    "ITENS"
  ];

  order.items.forEach((item) => {
    lines.push(`${item.quantity}x ${item.name}`);
    lines.push(`   ${formatCurrency(item.unitPrice)} un.  ${formatCurrency(item.total)}`);
    if (item.notes) lines.push(`   Obs: ${item.notes}`);
  });

  lines.push(repeat("-", 32));
  lines.push(`Subtotal: ${formatCurrency(order.totals.subtotal)}`);
  if (order.totals.deliveryFee > 0) {
    lines.push(`Entrega:  ${formatCurrency(order.totals.deliveryFee)}`);
  }
  lines.push(`TOTAL:    ${formatCurrency(order.totals.total)}`);
  lines.push(repeat("-", 32));
  lines.push(`Cliente: ${order.customer.name}`);
  if (order.customer.phone) lines.push(`Tel: ${order.customer.phone}`);
  lines.push(`Tipo: ${order.fulfillment.label}`);
  lines.push(`Prazo estimado: ${order.fulfillment.etaMinutes} min`);
  if (order.fulfillment.method === "delivery") {
    lines.push(`Região: ${order.fulfillment.regionName}`);
    lines.push(`Endereço: ${order.customer.address}`);
    if (order.customer.reference) lines.push(`Ref: ${order.customer.reference}`);
  }
  lines.push(`Pagamento: ${order.payment.label}`);
  if (order.notes) lines.push(`Obs geral: ${order.notes}`);
  lines.push(repeat("-", 32));
  lines.push("Pedido gerado pelo link.");
  lines.push("\n\n");

  return lines.join("\n");
}

function buildPrintText(order) {
  return [
    "[LOGO]",
    center(storeConfig.storeName, 32),
    repeat("-", 32),
    order.printBodyText || buildPrintBodyText(order)
  ].join("\n");
}

function buildWhatsappText(order) {
  return [
    `Novo pedido ${order.orderNumber}`,
    "",
    ...order.items.flatMap((item) => {
      const itemLines = [`${item.quantity}x ${item.name} - ${formatCurrency(item.total)}`];
      if (item.notes) itemLines.push(`Obs: ${item.notes}`);
      return itemLines;
    }),
    "",
    `Subtotal: ${formatCurrency(order.totals.subtotal)}`,
    order.totals.deliveryFee > 0 ? `Entrega: ${formatCurrency(order.totals.deliveryFee)}` : "",
    `Total: ${formatCurrency(order.totals.total)}`,
    "",
    `Cliente: ${order.customer.name}`,
    order.customer.phone ? `Telefone: ${order.customer.phone}` : "",
    `Forma: ${order.fulfillment.label}`,
    `Prazo estimado: ${order.fulfillment.etaMinutes} min`,
    order.fulfillment.method === "delivery" ? `Região: ${order.fulfillment.regionName}` : "",
    order.fulfillment.method === "delivery" ? `Endereço: ${order.customer.address}` : "",
    order.customer.reference ? `Referência: ${order.customer.reference}` : "",
    `Pagamento: ${order.payment.label}`,
    order.notes ? `Obs geral: ${order.notes}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDateTime(isoDate) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: cashWindowConfig.timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(isoDate)).replace(",", "");
}

function center(text, width) {
  if (text.length >= width) return text;
  const left = Math.floor((width - text.length) / 2);
  return `${" ".repeat(left)}${text}`;
}

function repeat(char, count) {
  return char.repeat(count);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function markPrinted(orderId) {
  const orders = await readOrders();
  const index = orders.findIndex((order) => order.id === orderId);
  if (index === -1) return null;

  orders[index] = {
    ...orders[index],
    printStatus: "printed",
    printedAt: new Date().toISOString()
  };

  await writeOrders(orders);
  return orders[index];
}

async function updateOrderStatus(orderId, nextStatus) {
  const status = normalizeOrderStatus(nextStatus);
  const orders = await readOrders();
  const index = orders.findIndex((order) => order.id === orderId);
  if (index === -1) return null;

  orders[index] = {
    ...orders[index],
    status,
    statusLabel: orderStatusLabels[status],
    statusUpdatedAt: new Date().toISOString()
  };

  await writeOrders(orders);
  return orders[index];
}

async function requestReprint(orderId) {
  const orders = await readOrders();
  const index = orders.findIndex((order) => order.id === orderId);
  if (index === -1) return null;

  orders[index] = {
    ...orders[index],
    printStatus: "pending",
    printedAt: null,
    reprintRequestedAt: new Date().toISOString()
  };

  await writeOrders(orders);
  return orders[index];
}

function serveStaticFile(requestPath, res) {
  let safePath;

  try {
    safePath = decodeURIComponent(requestPath);
  } catch (error) {
    sendJson(res, 400, { error: "Caminho inválido." });
    return;
  }

  if (safePath === "/") safePath = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Acesso negado." });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "Arquivo não encontrado." });
      return;
    }

    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}
