(function () {
  "use strict";

  const CURRENCY = "ETB";
  const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const MAX_EXTRA_PHOTOS = 5;

  // ---------- Session (only producers can open this page) ----------
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

  if (!token || !savedUser || savedUser.role !== "producer") {
    logout();
    return;
  }

  // ---------- Small helpers ----------
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

  function fullName(u) {
    return (u.firstName || "") + " " + (u.lastName || "");
  }

  function avatarHTML(u) {
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

  // ---------- Form helpers ----------
  function setFieldError(input, message) {
    const box = input.closest(".field");
    box.classList.add("invalid");
    box.querySelector(".error").textContent = message;
    return false;
  }

  function clearFieldErrors(form) {
    form.querySelectorAll(".field").forEach((box) => {
      box.classList.remove("invalid");
      const err = box.querySelector(".error");
      if (err) err.textContent = "";
    });
  }

  function formMessage(el, text, type) {
    el.textContent = text;
    el.className = "form-message show " + type;
  }

  function validateImage(input, maxMB) {
    const file = input.files[0];
    if (!file) return "";
    if (!IMAGE_TYPES.includes(file.type)) return "Only JPG, PNG or WEBP images are allowed.";
    if (file.size > maxMB * 1024 * 1024) return "Image must be " + maxMB + "MB or smaller.";
    return "";
  }

  function checkImageFile(file, maxMB) {
    if (!IMAGE_TYPES.includes(file.type)) return "Only JPG, PNG or WEBP images are allowed.";
    if (file.size > maxMB * 1024 * 1024) return '"' + file.name + '" is bigger than ' + maxMB + "MB.";
    return "";
  }

  function bindPreview(input, img, maxMB) {
    input.addEventListener("change", () => {
      const file = input.files[0];
      const problem = validateImage(input, maxMB);
      if (!file || problem) {
        img.hidden = true;
        img.removeAttribute("src");
        return;
      }
      img.src = URL.createObjectURL(file);
      img.hidden = false;
    });
  }

  function validateProduct(form) {
    clearFieldErrors(form);
    let ok = true;
    const name = field(form, "name");
    const desc = field(form, "description");
    const price = field(form, "price");
    const stock = field(form, "stock");

    if (name.value.trim().length < 2) ok = setFieldError(name, "Enter the product name (at least 2 characters).");
    if (desc.value.length > 1000) ok = setFieldError(desc, "Description is too long (max 1000 characters).");

    const p = Number(price.value);
    if (price.value === "" || !Number.isFinite(p) || p <= 0) ok = setFieldError(price, "Enter a price greater than 0.");

    const st = Number(stock.value);
    if (stock.value === "" || !Number.isInteger(st) || st < 0) ok = setFieldError(stock, "Enter a whole number (0 or more).");

    return ok;
  }

  // ---------- Modals ----------
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

  // ---------- Views ----------
  const views = {
    profile: $("viewProfile"),
    sales: $("viewSales"),
    search: $("viewSearch"),
    producer: $("viewProducer")
  };
  let currentView = "profile";
  let backTo = "profile";

  function showView(name) {
    Object.keys(views).forEach((key) => { views[key].hidden = key !== name; });
    currentView = name;
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    window.scrollTo(0, 0);
  }

  // ---------- Cards ----------
  function productCard(p, mode) {
    const img = p.imageUrl
      ? '<img src="' + esc(p.imageUrl) + '" alt="' + esc(p.name) + '" loading="lazy">'
      : '<span class="no-img">📦</span>';

    const stockText = p.stock > 0 ? p.stock + " in stock" : "Out of stock";

    let by = "";
    if (mode === "search" && p.producerName) {
      by = '<p class="by">by <a href="#" data-producer-id="' + esc(p.producerId) + '">' + esc(p.producerName) + "</a>" +
        (p.producerNickname ? ' <span class="nick">@' + esc(p.producerNickname) + "</span>" : "") + "</p>";
    }

    let actions = "";
    if (mode === "owner") {
      actions = '<div class="card-actions">' +
        '<button type="button" class="mini" data-edit="' + esc(p.id) + '">Edit</button>' +
        '<button type="button" class="mini danger" data-delete="' + esc(p.id) + '">Delete</button>' +
        "</div>";
    }

    return '<article class="product-card">' +
      '<div class="product-img">' + img + "</div>" +
      '<div class="product-body">' +
      "<h3>" + esc(p.name) + "</h3>" +
      '<p class="product-desc">' + esc(p.description) + "</p>" +
      '<div class="product-row"><span class="price">' + money(p.price) + "</span>" +
      '<span class="stock ' + (p.stock > 0 ? "" : "out") + '">' + stockText + "</span></div>" +
      by + actions +
      "</div></article>";
  }

  function personCard(u) {
    return '<article class="person-card" data-producer-id="' + esc(u.id) + '" role="button" tabindex="0">' +
      '<div class="avatar-md">' + avatarHTML(u) + "</div>" +
      "<div><h3>" + esc(fullName(u)) + "</h3>" +
      (u.nickname ? '<p class="nick">@' + esc(u.nickname) + "</p>" : "") +
      '<p class="meta">📍 ' + esc(u.city) + ", " + esc(u.country) + "</p></div></article>";
  }

  function fillGrid(grid, empty, items, render) {
    grid.innerHTML = items.map(render).join("");
    empty.hidden = items.length > 0;
  }

  // ---------- My profile ----------
  let me = null;
  let myProducts = [];

  function renderProfile(user, stats) {
    me = user;
    $("profileAvatar").innerHTML = avatarHTML(user);
    $("topAvatar").innerHTML = avatarHTML(user);
    $("profileName").textContent = fullName(user);
    $("profileNick").textContent = user.nickname ? "@" + user.nickname : "No nickname yet";
    $("profileBio").textContent = user.bio || "Add a short bio so buyers know more about you.";
    $("profileLocation").textContent = "📍 " + user.city + ", " + user.country;
    $("statProducts").textContent = stats.products;
    $("statSold").textContent = stats.itemsSold;
    $("statEarnings").textContent = money(stats.earnings);
  }

  async function loadProfile() {
    const data = await api("/api/profile/me");
    renderProfile(data.user, data.stats);
  }

  async function loadMyProducts() {
    const data = await api("/api/products/mine");
    myProducts = data.products;
    fillGrid($("myProducts"), $("myProductsEmpty"), myProducts, (p) => productCard(p, "owner"));
  }

  // ---------- Post product ----------
  bindPreview($("pImage"), $("pImagePreview"), 3);

  $("openPostBtn").addEventListener("click", () => {
    const form = $("postForm");
    form.reset();
    clearFieldErrors(form);
    $("postMessage").className = "form-message";
    $("pImagePreview").hidden = true;
    openModal($("postModal"));
  });

  $("postForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const message = $("postMessage");
    message.className = "form-message";

    if (!validateProduct(form)) return;

    const imageInput = field(form, "image");
    const imageProblem = validateImage(imageInput, 3);
    if (imageProblem) {
      setFieldError(imageInput, imageProblem);
      return;
    }

    const extraInput = $("pExtra");
    const extraFiles = Array.from(extraInput.files);
    if (extraFiles.length > MAX_EXTRA_PHOTOS) {
      setFieldError(extraInput, "You can add up to " + MAX_EXTRA_PHOTOS + " extra photos.");
      return;
    }
    for (const file of extraFiles) {
      const problem = checkImageFile(file, 3);
      if (problem) {
        setFieldError(extraInput, problem);
        return;
      }
    }

    const button = $("postSubmit");
    button.disabled = true;
    button.textContent = "Posting...";

    try {
      const body = new FormData(form);
      body.delete("extra"); // extra photos are sent in a second request
      const created = await api("/api/products", { method: "POST", body });

      let photoWarning = "";
      if (extraFiles.length > 0 && created.product && created.product.id) {
        const photos = new FormData();
        extraFiles.forEach((file) => photos.append("images", file));
        try {
          await api("/api/products/" + encodeURIComponent(created.product.id) + "/images", { method: "POST", body: photos });
        } catch (photoErr) {
          photoWarning = " But the extra photos failed: " + photoErr.message;
        }
      }

      closeModal($("postModal"));
      toast("Product posted!" + photoWarning, photoWarning ? "error" : "success");
      await Promise.all([loadMyProducts(), loadProfile()]);
    } catch (err) {
      formMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Post product";
    }
  });

  // ---------- Edit and delete product ----------
  function openEdit(id) {
    const product = myProducts.find((p) => p.id === id);
    if (!product) return;

    const form = $("editForm");
    clearFieldErrors(form);
    $("editMessage").className = "form-message";
    field(form, "id").value = product.id;
    field(form, "name").value = product.name;
    field(form, "description").value = product.description;
    field(form, "price").value = product.price;
    field(form, "stock").value = product.stock;
    $("galleryError").textContent = "";
    $("galleryInput").value = "";
    $("gallery").innerHTML = "";
    openModal($("editModal"));
    loadGallery(product.id);
  }

  // ---------- Product photo gallery ----------
  let galleryProductId = null;
  let galleryMax = MAX_EXTRA_PHOTOS;

  async function loadGallery(productId) {
    galleryProductId = productId;
    try {
      const data = await api("/api/products/" + encodeURIComponent(productId) + "/images");
      if (galleryProductId !== productId) return; // another product was opened meanwhile
      galleryMax = data.maxExtra || MAX_EXTRA_PHOTOS;
      $("gallery").innerHTML = data.images.map((img) =>
        '<div class="g-item"><img src="' + esc(img.url) + '" alt="Product photo">' +
        (img.main ? '<span class="g-badge">Main</span>' : '<button type="button" class="g-del" data-img-del="' + esc(img.id) + '" aria-label="Remove photo">×</button>') +
        "</div>"
      ).join("");
    } catch (err) {
      $("galleryError").textContent = err.message;
    }
  }

  $("galleryInput").addEventListener("change", async (e) => {
    const input = e.target;
    const files = Array.from(input.files);
    const errorBox = $("galleryError");
    errorBox.textContent = "";
    if (files.length === 0 || !galleryProductId) return;

    if (files.length > galleryMax) {
      errorBox.textContent = "You can add up to " + galleryMax + " extra photos.";
      input.value = "";
      return;
    }
    for (const file of files) {
      const problem = checkImageFile(file, 3);
      if (problem) {
        errorBox.textContent = problem;
        input.value = "";
        return;
      }
    }

    const body = new FormData();
    files.forEach((file) => body.append("images", file));
    input.disabled = true;
    try {
      await api("/api/products/" + encodeURIComponent(galleryProductId) + "/images", { method: "POST", body });
      toast("Photos added.", "success");
    } catch (err) {
      errorBox.textContent = err.message;
    } finally {
      input.value = "";
      input.disabled = false;
      await loadGallery(galleryProductId);
    }
  });

  async function removeGalleryPhoto(imageId) {
    if (!galleryProductId || !confirm("Remove this photo?")) return;
    try {
      await api("/api/products/" + encodeURIComponent(galleryProductId) + "/images/" + encodeURIComponent(imageId), { method: "DELETE" });
      toast("Photo removed.", "success");
    } catch (err) {
      $("galleryError").textContent = err.message;
    }
    await loadGallery(galleryProductId);
  }

  // ---------- Payout account ----------
  let payoutAccount = null;

  function renderPayout() {
    const a = payoutAccount;
    const card = $("payoutCard");
    if (a && a.accountNumber) {
      card.classList.remove("missing");
      const last4 = a.accountNumber.slice(-4);
      $("payoutText").textContent = a.bankName + " · " + a.accountName + " · account ending " + last4 +
        (a.mobile ? " · mobile " + a.mobile : "");
      $("openPayoutBtn").textContent = "Change";
    } else {
      card.classList.add("missing");
      $("payoutText").textContent = "Add your bank account so we can send you your money after a sale.";
      $("openPayoutBtn").textContent = "Add account";
    }
  }

  async function loadPayoutAccount() {
    const data = await api("/api/payout-account");
    payoutAccount = data.account;
    renderPayout();
  }

  $("openPayoutBtn").addEventListener("click", () => {
    const form = $("payoutForm");
    clearFieldErrors(form);
    $("payoutMessage").className = "form-message";
    const a = payoutAccount || {};
    field(form, "bankName").value = a.bankName || "";
    field(form, "accountName").value = a.accountName || "";
    field(form, "accountNumber").value = a.accountNumber || "";
    field(form, "mobile").value = a.mobile || "";
    openModal($("payoutModal"));
  });

  $("payoutForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    clearFieldErrors(form);
    const bank = field(form, "bankName");
    const holder = field(form, "accountName");
    const number = field(form, "accountNumber");
    const mobile = field(form, "mobile");
    let ok = true;

    if (bank.value.trim().length < 2) ok = setFieldError(bank, "Enter your bank name.");
    if (holder.value.trim().length < 2) ok = setFieldError(holder, "Enter the account holder name.");
    const digits = number.value.replace(/[\s-]/g, "");
    if (!/^\d{6,25}$/.test(digits)) ok = setFieldError(number, "Account number must be 6 to 25 digits.");
    const mob = mobile.value.replace(/[\s-]/g, "");
    if (mob && !/^\+?\d{9,15}$/.test(mob)) ok = setFieldError(mobile, "Enter a valid mobile number or leave it empty.");
    if (!ok) return;

    const button = $("payoutSubmit");
    const message = $("payoutMessage");
    message.className = "form-message";
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await api("/api/payout-account", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankName: bank.value.trim(),
          accountName: holder.value.trim(),
          accountNumber: digits,
          mobile: mob
        })
      });
      closeModal($("payoutModal"));
      toast("Payout account saved.", "success");
      await loadPayoutAccount();
    } catch (err) {
      formMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Save account";
    }
  });

  // ---------- My sales and payment progress ----------
  function stepHTML(state, title, note) {
    const mark = state === "done" ? "✓" : state === "bad" ? "!" : "•";
    return '<li class="' + state + '"><span class="dot">' + mark + "</span><strong>" + esc(title) + "</strong>" +
      (note ? "<small>" + esc(note) + "</small>" : "") + "</li>";
  }

  function fmtDate(value) {
    return value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  }

  function saleCard(sale) {
    const cancelled = sale.orderStatus === "cancelled";
    const paid = ["paid", "shipped", "delivered"].includes(sale.orderStatus);
    const shipped = sale.fulfillment === "shipped" || sale.fulfillment === "delivered";
    const delivered = sale.fulfillment === "delivered";
    const payoutDone = sale.payoutStatus === "paid";

    let steps;
    if (cancelled) {
      steps = stepHTML("done", "Ordered", fmtDate(sale.createdAt)) + stepHTML("bad", "Order cancelled", "No payment will be made.");
    } else {
      let paidNote = "Waiting for the customer to pay.";
      if (paid) paidNote = "The platform confirmed the money.";
      else if (sale.paymentStatus === "submitted") paidNote = "Receipt sent, the admin is checking it.";
      else if (sale.paymentStatus === "rejected") paidNote = "Receipt was rejected. Waiting for a new one.";

      const states = [
        "done",
        paid ? "done" : "current",
        shipped ? "done" : paid ? "current" : "",
        delivered ? "done" : shipped ? "current" : "",
        payoutDone ? "done" : delivered ? "current" : ""
      ];
      steps =
        stepHTML(states[0], "Ordered", fmtDate(sale.createdAt)) +
        stepHTML(states[1], "Customer paid", paidNote) +
        stepHTML(states[2], "Shipped", shipped ? "You sent it." : paid ? "Send it to the customer now." : "") +
        stepHTML(states[3], "Delivered", delivered ? "Customer received it." : shipped ? "Waiting for the customer to confirm." : "") +
        stepHTML(states[4], "Paid to you", payoutDone
          ? money(sale.earning) + (sale.payoutReference ? " · ref " + sale.payoutReference : "")
          : delivered ? "The platform will send " + money(sale.earning) + " soon." : "");
    }

    const c = sale.customer;
    const customerBox = c.revealed
      ? '<div class="customer-box"><strong>Deliver to:</strong> ' + esc(c.name) + "<br>📞 " + esc(c.phone) +
        "<br>📍 " + esc(c.address) + ", " + esc(c.city) + ", " + esc(c.country) + "</div>"
      : '<div class="customer-box">Customer details are shown after the customer\'s payment is confirmed.</div>';

    const thumb = sale.product.imageUrl ? '<img src="' + esc(sale.product.imageUrl) + '" alt="">' : "📦";
    const action = !cancelled && paid && sale.fulfillment === "new"
      ? '<div class="sale-actions"><button type="button" class="mini ok" data-ship="' + esc(sale.itemId) + '">Mark as shipped</button></div>'
      : "";

    return '<article class="sale-card">' +
      '<div class="sale-head"><div class="sale-thumb">' + thumb + "</div>" +
      '<div class="sale-title"><h3>' + esc(sale.product.name) + "</h3>" +
      '<p class="meta">' + esc(sale.quantity) + " × " + money(sale.price) + " · Order #" + esc(sale.orderId) +
      " · Your share: <strong>" + money(sale.earning) + "</strong></p></div></div>" +
      '<ol class="steps">' + steps + "</ol>" + customerBox + action + "</article>";
  }

  async function loadSales() {
    const data = await api("/api/sales/mine");
    $("slAwaiting").textContent = money(data.totals.awaitingPayment);
    $("slProgress").textContent = money(data.totals.inProgress);
    $("slReady").textContent = money(data.totals.ready);
    $("slPaid").textContent = money(data.totals.paidOut);
    $("salesList").innerHTML = data.sales.map(saleCard).join("");
    $("salesEmpty").hidden = data.sales.length > 0;
  }

  async function markShipped(itemId) {
    if (!confirm("Confirm that you have sent this item to the customer?")) return;
    try {
      await api("/api/sales/" + encodeURIComponent(itemId) + "/ship", { method: "POST" });
      toast("Marked as shipped.", "success");
      await loadSales();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("editForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const message = $("editMessage");
    message.className = "form-message";

    if (!validateProduct(form)) return;

    const body = {
      name: field(form, "name").value.trim(),
      description: field(form, "description").value.trim(),
      price: Number(field(form, "price").value),
      stock: Number(field(form, "stock").value)
    };

    const button = $("editSubmit");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await api("/api/products/" + encodeURIComponent(field(form, "id").value), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      closeModal($("editModal"));
      toast("Product updated.", "success");
      await loadMyProducts();
    } catch (err) {
      formMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Save changes";
    }
  });

  async function deleteProduct(id) {
    if (!confirm("Delete this product? Buyers will no longer see it.")) return;
    try {
      await api("/api/products/" + encodeURIComponent(id), { method: "DELETE" });
      toast("Product deleted.", "success");
      await Promise.all([loadMyProducts(), loadProfile()]);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // ---------- Edit profile ----------
  bindPreview($("fPhoto"), $("profilePreview"), 2);

  $("openEditProfileBtn").addEventListener("click", () => {
    if (!me) return;
    const form = $("profileForm");
    clearFieldErrors(form);
    $("profileMessage").className = "form-message";
    field(form, "nickname").value = me.nickname || "";
    field(form, "bio").value = me.bio || "";
    field(form, "profilePicture").value = "";
    $("profilePreview").hidden = true;
    openModal($("profileModal"));
  });

  $("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const message = $("profileMessage");
    message.className = "form-message";
    clearFieldErrors(form);

    const nickname = field(form, "nickname");
    const bio = field(form, "bio");
    const photo = field(form, "profilePicture");
    let ok = true;

    if (nickname.value.trim() && !/^[A-Za-z0-9_.-]{3,30}$/.test(nickname.value.trim())) {
      ok = setFieldError(nickname, "Use 3 to 30 characters: letters, numbers, dot, dash or underscore.");
    }
    if (bio.value.length > 300) ok = setFieldError(bio, "Bio must be 300 characters or less.");

    const photoProblem = validateImage(photo, 2);
    if (photoProblem) ok = setFieldError(photo, photoProblem);

    if (!ok) return;

    const button = $("profileSubmit");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await api("/api/profile/me", { method: "PUT", body: new FormData(form) });
      closeModal($("profileModal"));
      toast("Profile updated.", "success");
      await loadProfile();
    } catch (err) {
      formMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Save profile";
    }
  });

  // ---------- Search ----------
  $("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("searchInput").value.trim();
    const by = $("searchBy").value;

    if (!q) {
      $("searchInput").focus();
      return;
    }

    try {
      const data = await api("/api/search?q=" + encodeURIComponent(q) + "&by=" + encodeURIComponent(by));

      $("searchTitle").textContent = 'Results for "' + q + '"';
      $("searchProductsBox").hidden = by === "producer" || by === "nickname";
      $("searchProducersBox").hidden = by === "product";

      fillGrid($("searchProducts"), $("searchProductsEmpty"), data.products, (p) => productCard(p, "search"));
      fillGrid($("searchProducers"), $("searchProducersEmpty"), data.producers, personCard);

      showView("search");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("clearSearchBtn").addEventListener("click", () => {
    $("searchInput").value = "";
    showView("profile");
  });

  // ---------- Another producer's profile ----------
  async function openProducer(id) {
    if (currentView !== "producer") backTo = currentView;

    try {
      const data = await api("/api/producers/" + encodeURIComponent(id));
      const u = data.producer;

      $("pvAvatar").innerHTML = avatarHTML(u);
      $("pvName").textContent = fullName(u);
      $("pvNick").textContent = u.nickname ? "@" + u.nickname : "";
      $("pvBio").textContent = u.bio || "";
      $("pvLocation").textContent = "📍 " + u.city + ", " + u.country;
      $("pvJoined").textContent = "Member since " + new Date(u.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" });

      fillGrid($("pvProducts"), $("pvEmpty"), data.products, (p) => productCard(p, "public"));
      showView("producer");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("backBtn").addEventListener("click", () => showView(backTo));

  // ---------- Navigation and global events ----------
  $("brandLink").addEventListener("click", (e) => { e.preventDefault(); showView("profile"); });
  $("myProfileBtn").addEventListener("click", () => showView("profile"));

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      const name = tab.dataset.tab;
      if (name === "messages") {
        if (window.HBChat) window.HBChat.openInbox();
        return;
      }
      showView(name);
      if (name === "sales") {
        try { await loadSales(); } catch (err) { toast(err.message, "error"); }
      }
    });
  });
  $("logoutBtn").addEventListener("click", logout);

  document.addEventListener("click", (e) => {
    const producerLink = e.target.closest("[data-producer-id]");
    if (producerLink) {
      e.preventDefault();
      openProducer(producerLink.dataset.producerId);
      return;
    }

    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      openEdit(Number(editBtn.dataset.edit));
      return;
    }

    const deleteBtn = e.target.closest("[data-delete]");
    if (deleteBtn) {
      deleteProduct(Number(deleteBtn.dataset.delete));
      return;
    }

    const imgDel = e.target.closest("[data-img-del]");
    if (imgDel) {
      removeGalleryPhoto(Number(imgDel.dataset.imgDel));
      return;
    }

    const shipBtn = e.target.closest("[data-ship]");
    if (shipBtn) {
      markShipped(Number(shipBtn.dataset.ship));
      return;
    }

    const closeBtn = e.target.closest("[data-close]");
    if (closeBtn) {
      closeModal(closeBtn.closest(".modal"));
      return;
    }

    if (e.target.classList.contains("modal")) closeModal(e.target);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal:not([hidden])").forEach(closeModal);
    }
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("person-card")) {
      openProducer(e.target.dataset.producerId);
    }
  });

  // ---------- Start ----------
  $("topAvatar").innerHTML = avatarHTML(savedUser);

  (async function init() {
    try {
      await Promise.all([loadProfile(), loadMyProducts(), loadPayoutAccount()]);
    } catch (err) {
      toast(err.message, "error");
    }
  })();
})();
