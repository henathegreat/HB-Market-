(function () {
  "use strict";

  const CURRENCY = "ETB";

  // ---------- Session (only the admin can open this page) ----------
  function readStored(key) {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  }

  function logout() {
    ["token", "user"].forEach((key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
    window.location.href = "login.html";
  }

  const token = readStored("token");
  let savedUser = null;
  try {
    savedUser = JSON.parse(readStored("user") || "null");
  } catch (e) {
    savedUser = null;
  }

  if (!token || !savedUser) {
    logout();
    return;
  }
  if (savedUser.role !== "admin") {
    window.location.href = "login.html";
    return;
  }

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const field = (form, name) => form.querySelector('[name="' + name + '"]');

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function money(amount) {
    return CURRENCY + " " + Number(amount).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatDate(value) {
    return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }

  function badge(text, cls) {
    return '<span class="status ' + esc(cls) + '">' + esc(text) + "</span>";
  }

  function showMessage(el, text, type) {
    el.textContent = text;
    el.className = "form-message show " + type;
  }

  function avatarInner(u) {
    if (u.profilePicture) return '<img src="' + esc(u.profilePicture) + '" alt="">';
    const initials = ((u.firstName || "")[0] || "") + ((u.lastName || "")[0] || "");
    return "<span>" + esc(initials.toUpperCase()) + "</span>";
  }

  let toastTimer;
  function toast(message, type) {
    const el = $("toast");
    el.textContent = message;
    el.className = "toast show " + (type || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 3200);
  }

  async function api(url, options) {
    const opts = options || {};
    const headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
    const response = await fetch(url, Object.assign({}, opts, { headers }));
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      logout();
      throw new Error("Please log in again.");
    }
    if (!response.ok) throw new Error(data.message || "Something went wrong.");
    return data;
  }

  function postJSON(url, body) {
    return api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  function putJSON(url, body) {
    return api(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (!document.querySelector(".modal:not([hidden])")) {
      document.body.classList.remove("modal-open");
    }
  }

  // ---------- Lists with pages ----------
  const state = {
    users: { q: "", role: "", page: 1, pages: 1, items: [] },
    products: { q: "", status: "all", page: 1, pages: 1, items: [] },
    orders: { q: "", status: "", page: 1, pages: 1, items: [] }
  };

  function renderPager(name) {
    const st = state[name];
    const box = $(name + "Pager");

    if (st.pages <= 1) {
      box.innerHTML = "";
      return;
    }

    box.innerHTML =
      '<button type="button" class="mini" data-list="' + name + '" data-page="prev"' + (st.page <= 1 ? " disabled" : "") + ">← Previous</button>" +
      "<span>Page " + st.page + " of " + st.pages + "</span>" +
      '<button type="button" class="mini" data-list="' + name + '" data-page="next"' + (st.page >= st.pages ? " disabled" : "") + ">Next →</button>";
  }

  // =====================================================
  // OVERVIEW
  // =====================================================
  async function loadOverview() {
    const [summary, overview] = await Promise.all([api("/api/admin/summary"), api("/api/admin/overview")]);

    $("sumWaiting").textContent = summary.waiting;
    $("sumConfirmed").textContent = money(summary.confirmedTotal);
    $("sumCommission").textContent = money(summary.commission);
    $("sumEarnings").textContent = money(summary.producerEarnings);

    $("ovConsumers").textContent = overview.consumers;
    $("ovProducers").textContent = overview.producers;
    $("ovProducts").textContent = overview.products;
    $("ovOrders").textContent = overview.orders;
    $("ovPending").textContent = overview.pendingOrders;
    $("ovBlocked").textContent = overview.blocked;
  }

  // =====================================================
  // PAYMENTS
  // =====================================================
  let paymentStatus = "submitted";
  let payments = [];

  function paymentCard(p) {
    const id = Number(p.id);
    const items = p.items.map((i) =>
      "<li>" + Number(i.quantity) + " × " + esc(i.name) + ' <small class="muted">by ' + esc(i.producerName) + "</small></li>"
    ).join("");

    const methodText = p.method === "telebirr" ? "Telebirr" : "Bank transfer";

    let actions = '<button type="button" class="mini" data-receipt="' + id + '">View receipt</button>';
    if (p.status === "submitted") {
      actions += '<button type="button" class="mini ok" data-confirm="' + id + '">Confirm payment</button>' +
        '<button type="button" class="mini danger" data-reject="' + id + '">Reject</button>';
    }

    let extra = "";
    if (p.status === "confirmed") {
      extra = '<p class="pay-state ok">✓ Confirmed on ' + esc(formatDate(p.reviewedAt)) + "</p>";
    } else if (p.status === "rejected") {
      extra = '<p class="pay-state bad">Rejected: ' + esc(p.note || "") + "</p>";
    }

    return '<article class="pay-card">' +
      '<div class="pay-head"><strong>Order #' + Number(p.orderId) + "</strong>" + badge(p.status, p.status) + "</div>" +
      '<dl class="pay-grid">' +
      "<div><dt>Customer</dt><dd>" + esc(p.customer.name) + "</dd></div>" +
      "<div><dt>Phone</dt><dd>" + esc(p.customer.phone) + "</dd></div>" +
      "<div><dt>Email</dt><dd>" + esc(p.customer.email) + "</dd></div>" +
      "<div><dt>Method</dt><dd>" + methodText + (p.senderBank ? " (" + esc(p.senderBank) + ")" : "") + "</dd></div>" +
      "<div><dt>Reference number</dt><dd>" + esc(p.reference) + "</dd></div>" +
      "<div><dt>Amount sent</dt><dd>" + money(p.amount) + "</dd></div>" +
      "<div><dt>Order total</dt><dd>" + money(p.orderTotal) + "</dd></div>" +
      "<div><dt>Sent on</dt><dd>" + esc(formatDate(p.createdAt)) + "</dd></div>" +
      "</dl>" +
      '<ul class="pay-items">' + items + "</ul>" +
      '<div class="pay-actions">' + actions + "</div>" +
      extra +
      "</article>";
  }

  async function loadPayments() {
    const data = await api("/api/admin/payments?status=" + encodeURIComponent(paymentStatus));
    payments = data.payments;
    $("paymentList").innerHTML = payments.map(paymentCard).join("");
    $("paymentEmpty").hidden = payments.length > 0;
  }

  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", async () => {
      paymentStatus = button.dataset.status;
      document.querySelectorAll(".filter").forEach((b) => b.classList.toggle("active", b === button));
      try {
        await loadPayments();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  // Receipts are private, so the photo is loaded with the login token
  let receiptUrl = null;

  async function viewReceipt(id) {
    try {
      const response = await fetch("/api/payments/" + encodeURIComponent(id) + "/receipt", {
        headers: { Authorization: "Bearer " + token }
      });
      if (!response.ok) throw new Error("Could not load the receipt.");

      const blob = await response.blob();
      if (receiptUrl) URL.revokeObjectURL(receiptUrl);
      receiptUrl = URL.createObjectURL(blob);

      $("receiptImg").src = receiptUrl;
      openModal($("receiptModal"));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function confirmPayment(id) {
    const payment = payments.find((p) => p.id === id);
    if (!payment) return;

    if (!confirm("Confirm that " + money(payment.amount) + " arrived for order #" + payment.orderId + "?")) return;

    try {
      await postJSON("/api/admin/payments/" + encodeURIComponent(id) + "/confirm");
      toast("Payment confirmed. The order is now paid.", "success");
      await loadPayments();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  let rejectId = null;

  function openReject(id) {
    rejectId = id;
    const form = $("rejectForm");
    form.reset();
    form.querySelector(".field").classList.remove("invalid");
    form.querySelector(".error").textContent = "";
    $("rejectMessage").className = "form-message";
    openModal($("rejectModal"));
  }

  $("rejectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const note = field(form, "note");
    const box = note.closest(".field");
    const message = $("rejectMessage");
    message.className = "form-message";

    if (note.value.trim().length < 3) {
      box.classList.add("invalid");
      box.querySelector(".error").textContent = "Write a reason (at least 3 characters).";
      return;
    }
    box.classList.remove("invalid");
    box.querySelector(".error").textContent = "";

    const button = $("rejectSubmit");
    button.disabled = true;
    button.textContent = "Rejecting...";

    try {
      await postJSON("/api/admin/payments/" + encodeURIComponent(rejectId) + "/reject", { note: note.value.trim() });
      closeModal($("rejectModal"));
      toast("Receipt rejected.", "success");
      await loadPayments();
    } catch (err) {
      showMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Reject receipt";
    }
  });

  // =====================================================
  // USERS
  // =====================================================
  function userCard(u) {
    const id = Number(u.id);
    const isMe = id === Number(savedUser.id);
    const name = u.firstName + " " + u.lastName;

    let counts = "";
    if (u.role === "producer") counts = " · " + u.productCount + " products";
    if (u.role === "consumer") counts = " · " + u.orderCount + " orders";

    const actions =
      '<button type="button" class="mini" data-user-edit="' + id + '">Edit</button>' +
      '<button type="button" class="mini" data-user-pass="' + id + '">Reset password</button>' +
      (isMe ? "" :
        '<button type="button" class="mini ' + (u.isActive ? "danger" : "ok") + '" data-user-toggle="' + id + '">' +
        (u.isActive ? "Block" : "Unblock") + "</button>");

    return '<article class="row-card">' +
      '<div class="avatar-md">' + avatarInner(u) + "</div>" +
      '<div class="row-main">' +
      "<h3>" + esc(name) + (isMe ? ' <small class="muted">(you)</small>' : "") + "</h3>" +
      '<p class="row-badges">' + badge(u.role, "role-" + u.role) + badge(u.isActive ? "Active" : "Blocked", u.isActive ? "confirmed" : "off") + "</p>" +
      '<p class="row-meta">' + esc(u.email) + " · " + esc(u.phone) + "</p>" +
      '<p class="row-meta">📍 ' + esc(u.city) + ", " + esc(u.country) +
      (u.nickname ? " · @" + esc(u.nickname) : "") + esc(counts) + "</p>" +
      '<p class="row-meta">Joined ' + esc(new Date(u.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })) + "</p>" +
      "</div>" +
      '<div class="row-actions">' + actions + "</div>" +
      "</article>";
  }

  async function loadUsers() {
    const st = state.users;
    const params = new URLSearchParams({ q: st.q, role: st.role, page: st.page });
    const data = await api("/api/admin/users?" + params.toString());

    st.items = data.users;
    st.page = data.page;
    st.pages = data.pages;

    $("usersList").innerHTML = data.users.map(userCard).join("");
    $("usersEmpty").hidden = data.users.length > 0;
    $("usersCount").textContent = data.total + " found";
    renderPager("users");
  }

  $("userSearchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.users.q = $("userQ").value.trim();
    state.users.role = $("userRole").value;
    state.users.page = 1;
    try {
      await loadUsers();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  let editingUserId = null;

  function openUserEdit(id) {
    const u = state.users.items.find((x) => x.id === id);
    if (!u) return;

    editingUserId = id;
    const form = $("userForm");
    form.reset();
    $("userMessage").className = "form-message";
    $("userTitle").textContent = "Edit " + u.firstName + " " + u.lastName;

    field(form, "firstName").value = u.firstName;
    field(form, "lastName").value = u.lastName;
    field(form, "email").value = u.email;
    field(form, "phone").value = u.phone;
    field(form, "birthday").value = u.birthday || "";
    field(form, "gender").value = u.gender;
    field(form, "country").value = u.country;
    field(form, "city").value = u.city;
    field(form, "address").value = u.address;
    field(form, "role").value = u.role;
    field(form, "nickname").value = u.nickname || "";
    field(form, "bio").value = u.bio || "";

    const isMe = id === Number(savedUser.id);
    field(form, "role").disabled = isMe;
    $("userRoleNote").hidden = !isMe;

    openModal($("userModal"));
  }

  $("userForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const message = $("userMessage");
    message.className = "form-message";

    const body = {};
    ["firstName", "lastName", "email", "phone", "birthday", "gender", "country", "city", "address", "role", "nickname", "bio"]
      .forEach((name) => { body[name] = field(form, name).value.trim(); });

    const button = $("userSubmit");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await putJSON("/api/admin/users/" + encodeURIComponent(editingUserId), body);
      closeModal($("userModal"));
      toast("User updated.", "success");
      await loadUsers();
    } catch (err) {
      showMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Save changes";
    }
  });

  async function toggleUser(id) {
    const u = state.users.items.find((x) => x.id === id);
    if (!u) return;

    const name = u.firstName + " " + u.lastName;
    const question = u.isActive
      ? "Block " + name + "? They will not be able to log in and their products will be hidden."
      : "Unblock " + name + "?";
    if (!confirm(question)) return;

    try {
      await postJSON("/api/admin/users/" + encodeURIComponent(id) + "/status", { active: !u.isActive });
      toast(u.isActive ? "Account blocked." : "Account unblocked.", "success");
      await loadUsers();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  let passUserId = null;

  function openUserPassword(id) {
    const u = state.users.items.find((x) => x.id === id);
    if (!u) return;

    passUserId = id;
    const form = $("passForm");
    form.reset();
    form.querySelector(".field").classList.remove("invalid");
    form.querySelector(".error").textContent = "";
    $("passMessage").className = "form-message";
    $("passTitle").textContent = "Reset password for " + u.firstName + " " + u.lastName;
    openModal($("passModal"));
  }

  $("passForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const input = field(form, "password");
    const box = input.closest(".field");
    const message = $("passMessage");
    message.className = "form-message";

    const value = input.value;
    if (value.length < 8 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
      box.classList.add("invalid");
      box.querySelector(".error").textContent = "Use at least 8 characters with letters and numbers.";
      return;
    }
    box.classList.remove("invalid");
    box.querySelector(".error").textContent = "";

    const button = $("passSubmit");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await postJSON("/api/admin/users/" + encodeURIComponent(passUserId) + "/password", { password: value });
      closeModal($("passModal"));
      toast("Password changed. Tell the user the new password.", "success");
    } catch (err) {
      showMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Set new password";
    }
  });

  // My own password
  $("myPassBtn").addEventListener("click", () => {
    const form = $("myPassForm");
    form.reset();
    form.querySelectorAll(".field").forEach((box) => {
      box.classList.remove("invalid");
      box.querySelector(".error").textContent = "";
    });
    $("myPassMessage").className = "form-message";
    openModal($("myPassModal"));
  });

  $("myPassForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const message = $("myPassMessage");
    message.className = "form-message";

    const current = field(form, "currentPassword");
    const next = field(form, "newPassword");
    const confirmInput = field(form, "confirmPassword");
    let ok = true;

    function problem(input, text) {
      const box = input.closest(".field");
      box.classList.add("invalid");
      box.querySelector(".error").textContent = text;
      ok = false;
    }

    form.querySelectorAll(".field").forEach((box) => {
      box.classList.remove("invalid");
      box.querySelector(".error").textContent = "";
    });

    if (!current.value) problem(current, "Enter your current password.");
    if (next.value.length < 8 || !/[A-Za-z]/.test(next.value) || !/\d/.test(next.value)) {
      problem(next, "Use at least 8 characters with letters and numbers.");
    }
    if (confirmInput.value !== next.value) problem(confirmInput, "Passwords do not match.");
    if (!ok) return;

    const button = $("myPassSubmit");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await postJSON("/api/account/change-password", {
        currentPassword: current.value,
        newPassword: next.value
      });
      closeModal($("myPassModal"));
      toast("Your password was changed.", "success");
    } catch (err) {
      showMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Change password";
    }
  });

  // =====================================================
  // PRODUCTS
  // =====================================================
  function productCard(p) {
    const id = Number(p.id);
    const img = p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" alt="">' : "📦";

    return '<article class="row-card">' +
      '<div class="thumb">' + img + "</div>" +
      '<div class="row-main">' +
      "<h3>" + esc(p.name) + "</h3>" +
      '<p class="row-badges">' + badge(p.isActive ? "Visible" : "Hidden", p.isActive ? "confirmed" : "off") + "</p>" +
      '<p class="row-meta">' + money(p.price) + " · " + Number(p.stock) + " in stock</p>" +
      '<p class="row-meta">Producer: ' + esc(p.producerName) + "</p>" +
      "</div>" +
      '<div class="row-actions">' +
      '<button type="button" class="mini" data-prod-edit="' + id + '">Edit</button>' +
      '<button type="button" class="mini ' + (p.isActive ? "danger" : "ok") + '" data-prod-toggle="' + id + '">' +
      (p.isActive ? "Hide" : "Show") + "</button>" +
      "</div></article>";
  }

  async function loadProducts() {
    const st = state.products;
    const params = new URLSearchParams({ q: st.q, status: st.status, page: st.page });
    const data = await api("/api/admin/products?" + params.toString());

    st.items = data.products;
    st.page = data.page;
    st.pages = data.pages;

    $("productsList").innerHTML = data.products.map(productCard).join("");
    $("productsEmpty").hidden = data.products.length > 0;
    $("productsCount").textContent = data.total + " found";
    renderPager("products");
  }

  $("productSearchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.products.q = $("productQ").value.trim();
    state.products.status = $("productStatus").value;
    state.products.page = 1;
    try {
      await loadProducts();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  let editingProductId = null;

  function openProductEdit(id) {
    const p = state.products.items.find((x) => x.id === id);
    if (!p) return;

    editingProductId = id;
    const form = $("productForm");
    form.reset();
    $("productMessage").className = "form-message";
    $("productEditTitle").textContent = "Edit " + p.name;

    field(form, "name").value = p.name;
    field(form, "description").value = p.description;
    field(form, "price").value = p.price;
    field(form, "stock").value = p.stock;
    openModal($("productModal"));
  }

  $("productForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const message = $("productMessage");
    message.className = "form-message";

    const body = {
      name: field(form, "name").value.trim(),
      description: field(form, "description").value.trim(),
      price: field(form, "price").value,
      stock: field(form, "stock").value
    };

    const button = $("productSubmit");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await putJSON("/api/admin/products/" + encodeURIComponent(editingProductId), body);
      closeModal($("productModal"));
      toast("Product updated.", "success");
      await loadProducts();
    } catch (err) {
      showMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Save changes";
    }
  });

  async function toggleProduct(id) {
    const p = state.products.items.find((x) => x.id === id);
    if (!p) return;

    const question = p.isActive
      ? 'Hide "' + p.name + '" from the shop?'
      : 'Show "' + p.name + '" in the shop again?';
    if (!confirm(question)) return;

    try {
      await postJSON("/api/admin/products/" + encodeURIComponent(id) + "/visibility", { active: !p.isActive });
      toast(p.isActive ? "Product hidden." : "Product is visible again.", "success");
      await loadProducts();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // =====================================================
  // ORDERS
  // =====================================================
  const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"];

  function orderCard(o) {
    const id = Number(o.id);
    const items = o.items.map((i) =>
      "<li>" + Number(i.quantity) + " × " + esc(i.name) + ' <small class="muted">by ' + esc(i.producerName) + "</small> — " + money(i.subtotal) + "</li>"
    ).join("");

    const paymentText = o.paymentStatus ? "Receipt: " + o.paymentStatus : "No receipt yet";

    let edit = "";
    if (o.status !== "cancelled") {
      const options = ORDER_STATUSES.map((s) =>
        '<option value="' + s + '"' + (s === o.status ? " selected" : "") + ">" + s + "</option>"
      ).join("");
      edit = '<div class="order-edit"><select data-order-id="' + id + '" aria-label="New status">' + options + "</select>" +
        '<button type="button" class="mini ok" data-order-save="' + id + '">Update status</button></div>';
    }

    return '<article class="row-card">' +
      '<div class="row-main">' +
      "<h3>Order #" + id + "</h3>" +
      '<p class="row-badges">' + badge(o.status, o.status) + badge(paymentText, o.paymentStatus === "confirmed" ? "confirmed" : o.paymentStatus === "rejected" ? "off" : "") + "</p>" +
      '<p class="row-meta">' + esc(formatDate(o.createdAt)) + "</p>" +
      '<p class="row-meta">Customer: ' + esc(o.customer.name) + " · " + esc(o.customer.phone) + " · " + esc(o.customer.email) + "</p>" +
      '<ul class="order-items">' + items + "</ul>" +
      "<strong>Total: " + money(o.total) + "</strong>" +
      edit +
      "</div></article>";
  }

  async function loadOrders() {
    const st = state.orders;
    const params = new URLSearchParams({ q: st.q, status: st.status, page: st.page });
    const data = await api("/api/admin/orders?" + params.toString());

    st.items = data.orders;
    st.page = data.page;
    st.pages = data.pages;

    $("ordersList").innerHTML = data.orders.map(orderCard).join("");
    $("ordersEmpty").hidden = data.orders.length > 0;
    $("ordersCount").textContent = data.total + " found";
    renderPager("orders");
  }

  $("orderSearchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.orders.q = $("orderQ").value.trim();
    state.orders.status = $("orderStatusFilter").value;
    state.orders.page = 1;
    try {
      await loadOrders();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  async function saveOrderStatus(id) {
    const select = document.querySelector('select[data-order-id="' + id + '"]');
    const order = state.orders.items.find((o) => o.id === id);
    if (!select || !order) return;

    const status = select.value;
    if (status === order.status) {
      toast("Choose a different status first.", "error");
      return;
    }

    const question = status === "cancelled"
      ? "Cancel order #" + id + "? The items go back to stock and this cannot be undone."
      : "Change order #" + id + " to " + status + "?";
    if (!confirm(question)) return;

    try {
      await postJSON("/api/admin/orders/" + encodeURIComponent(id) + "/status", { status });
      toast("Order status updated.", "success");
      await loadOrders();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // =====================================================
  // TABS
  // =====================================================
  // =====================================================
  // PAYOUTS TO PRODUCERS
  // =====================================================
  let payouts = [];
  let payoutProducerId = null;

  function payoutCard(p) {
    const acct = p.account
      ? '<p class="acct">🏦 ' + esc(p.account.bank) + " · " + esc(p.account.name) + " · <strong>" + esc(p.account.number) + "</strong>" +
        (p.account.mobile ? " · 📱 " + esc(p.account.mobile) : "") + "</p>"
      : '<p class="acct none">This producer has not added a payout account yet.</p>';

    const button = p.owed > 0
      ? '<button type="button" class="mini ok" data-payout="' + esc(p.producerId) + '">Record payout</button>'
      : "";

    return '<article class="payout-row"><h3>' + esc(p.name) + ' <span class="muted">' + esc(p.phone || "") + "</span></h3>" + acct +
      '<div class="payout-nums">' +
      "<div><strong>" + money(p.owed) + "</strong>Owed now</div>" +
      "<div><strong>" + money(p.inProgress) + "</strong>In progress</div>" +
      "<div><strong>" + money(p.paidTotal) + "</strong>Paid so far</div></div>" + button + "</article>";
  }

  async function loadPayouts() {
    const data = await api("/api/admin/payouts");
    payouts = data.payouts;
    $("payoutsList").innerHTML = payouts.map(payoutCard).join("");
    $("payoutsEmpty").hidden = payouts.length > 0;
  }

  function openPayout(producerId) {
    const p = payouts.find((x) => x.producerId === producerId);
    if (!p) return;
    payoutProducerId = producerId;
    const form = $("payoutForm");
    field(form, "reference").value = "";
    const box = field(form, "reference").closest(".field");
    box.classList.remove("invalid");
    box.querySelector(".error").textContent = "";
    $("payoutMessage").className = "form-message";
    $("payoutTitle").textContent = "Pay " + p.name;
    $("payoutNote").textContent = "Send " + money(p.owed) + (p.account ? " to " + p.account.bank + " account " + p.account.number + "." : ".") +
      " Then enter the bank transfer reference below.";
    openModal($("payoutModal"));
  }

  $("payoutForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const ref = field(form, "reference");
    const box = ref.closest(".field");
    const message = $("payoutMessage");
    message.className = "form-message";

    if (ref.value.trim().length < 3) {
      box.classList.add("invalid");
      box.querySelector(".error").textContent = "Enter the transfer reference (at least 3 characters).";
      return;
    }
    box.classList.remove("invalid");
    box.querySelector(".error").textContent = "";

    const button = $("payoutSubmit");
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      await postJSON("/api/admin/payouts/" + encodeURIComponent(payoutProducerId) + "/pay", { reference: ref.value.trim() });
      closeModal($("payoutModal"));
      toast("Payout recorded.", "success");
      await loadPayouts();
    } catch (err) {
      showMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Mark as paid";
    }
  });

  const loaders = {
    overview: loadOverview,
    payments: loadPayments,
    users: loadUsers,
    products: loadProducts,
    orders: loadOrders,
    payouts: loadPayouts
  };

  async function showTab(name) {
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== "tab" + name.charAt(0).toUpperCase() + name.slice(1);
    });
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });

    try {
      await loaders[name]();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });

  // =====================================================
  // GLOBAL EVENTS
  // =====================================================
  $("logoutBtn").addEventListener("click", logout);

  document.addEventListener("click", async (e) => {
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn) {
      const name = pageBtn.dataset.list;
      state[name].page += pageBtn.dataset.page === "next" ? 1 : -1;
      try {
        await loaders[name]();
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }

    const receiptBtn = e.target.closest("[data-receipt]");
    if (receiptBtn) { viewReceipt(Number(receiptBtn.dataset.receipt)); return; }

    const confirmBtn = e.target.closest("[data-confirm]");
    if (confirmBtn) { confirmPayment(Number(confirmBtn.dataset.confirm)); return; }

    const rejectBtn = e.target.closest("[data-reject]");
    if (rejectBtn) { openReject(Number(rejectBtn.dataset.reject)); return; }

    const userEdit = e.target.closest("[data-user-edit]");
    if (userEdit) { openUserEdit(Number(userEdit.dataset.userEdit)); return; }

    const userPass = e.target.closest("[data-user-pass]");
    if (userPass) { openUserPassword(Number(userPass.dataset.userPass)); return; }

    const userToggle = e.target.closest("[data-user-toggle]");
    if (userToggle) { toggleUser(Number(userToggle.dataset.userToggle)); return; }

    const prodEdit = e.target.closest("[data-prod-edit]");
    if (prodEdit) { openProductEdit(Number(prodEdit.dataset.prodEdit)); return; }

    const prodToggle = e.target.closest("[data-prod-toggle]");
    if (prodToggle) { toggleProduct(Number(prodToggle.dataset.prodToggle)); return; }

    const payoutBtn = e.target.closest("[data-payout]");
    if (payoutBtn) { openPayout(Number(payoutBtn.dataset.payout)); return; }

    const orderSave = e.target.closest("[data-order-save]");
    if (orderSave) { saveOrderStatus(Number(orderSave.dataset.orderSave)); return; }

    const closeBtn = e.target.closest("[data-close]");
    if (closeBtn) { closeModal(closeBtn.closest(".modal")); return; }

    if (e.target.classList.contains("modal")) closeModal(e.target);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal:not([hidden])").forEach(closeModal);
    }
  });

  // ---------- Start ----------
  $("adminName").textContent = ((savedUser.firstName || "") + " " + (savedUser.lastName || "")).trim();
  showTab("overview");
})();
