// Handles: login.html, forgot-password.html, reset-password.html

// ---------- Helpers ----------
function setError(input, message) {
  const field = input.closest(".field");
  field.classList.remove("valid");
  field.classList.add("invalid");
  field.querySelector(".error").textContent = message;
  return false;
}

function setValid(input) {
  const field = input.closest(".field");
  field.classList.remove("invalid");
  field.classList.add("valid");
  field.querySelector(".error").textContent = "";
  return true;
}

function showMessage(text, type) {
  const box = document.getElementById("formMessage");
  box.textContent = text;
  box.className = "form-message show " + type;
}

function clearMessage() {
  document.getElementById("formMessage").className = "form-message";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

async function postJSON(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function setLoading(button, loading, text) {
  button.disabled = loading;
  button.textContent = text;
}

// Show / hide password buttons
document.querySelectorAll(".toggle-pass").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
  });
});

// ---------- LOGIN ----------
const loginForm = document.getElementById("loginForm");

if (loginForm) {
  const submitBtn = document.getElementById("submitBtn");

  const dashboards = {
    producer: "producer-dashboard.html",
    consumer: "consumer-dashboard.html",
    admin: "admin.html"
  };

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMessage();

    const email = loginForm.elements.email;
    const password = loginForm.elements.password;
    let ok = true;

    if (!email.value.trim()) ok = setError(email, "Email is required.");
    else if (!isValidEmail(email.value.trim())) ok = setError(email, "Enter a valid email address.");
    else setValid(email);

    if (!password.value) ok = setError(password, "Password is required.");
    else setValid(password);

    if (!ok) return;

    setLoading(submitBtn, true, "Logging in...");

    try {
      const { ok: success, data } = await postJSON("/api/auth/login", {
        email: email.value.trim().toLowerCase(),
        password: password.value
      });

      if (success) {
        const storage = loginForm.elements.remember.checked ? localStorage : sessionStorage;
        storage.setItem("token", data.token);
        storage.setItem("user", JSON.stringify(data.user));

        showMessage("Login successful! Redirecting...", "success");
        const target = dashboards[data.user.role] || "login.html";
        setTimeout(() => (window.location.href = target), 800);
      } else {
        showMessage(data.message || "Incorrect email or password.", "fail");
        setLoading(submitBtn, false, "Log in");
      }
    } catch (err) {
      showMessage("Cannot reach the server. Make sure it is running.", "fail");
      setLoading(submitBtn, false, "Log in");
    }
  });
}

// ---------- FORGOT PASSWORD ----------
const forgotForm = document.getElementById("forgotForm");

if (forgotForm) {
  const submitBtn = document.getElementById("submitBtn");

  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMessage();

    const email = forgotForm.elements.email;

    if (!email.value.trim()) return setError(email, "Email is required.");
    if (!isValidEmail(email.value.trim())) return setError(email, "Enter a valid email address.");
    setValid(email);

    setLoading(submitBtn, true, "Sending...");

    try {
      const { ok: success, data } = await postJSON("/api/auth/forgot-password", {
        email: email.value.trim().toLowerCase()
      });

      if (success) {
        // Same message whether or not the email exists (protects user privacy)
        showMessage("If an account exists for this email, a reset link has been sent. Please check your inbox.", "success");
      } else {
        showMessage(data.message || "Something went wrong. Please try again.", "fail");
      }
    } catch (err) {
      showMessage("Cannot reach the server. Make sure it is running.", "fail");
    }

    setLoading(submitBtn, false, "Send reset link");
  });
}

// ---------- RESET PASSWORD ----------
const resetForm = document.getElementById("resetForm");

if (resetForm) {
  const submitBtn = document.getElementById("submitBtn");
  const token = new URLSearchParams(window.location.search).get("token");

  if (!token) {
    showMessage("This reset link is invalid or incomplete. Please request a new one.", "fail");
    submitBtn.disabled = true;
  }

  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMessage();
    if (!token) return;

    const password = resetForm.elements.password;
    const confirm = resetForm.elements.confirmPassword;
    let ok = true;

    if (password.value.length < 8) ok = setError(password, "Password must be at least 8 characters.");
    else if (!/[A-Za-z]/.test(password.value) || !/\d/.test(password.value)) ok = setError(password, "Use letters and numbers.");
    else setValid(password);

    if (!confirm.value) ok = setError(confirm, "Confirm your password.");
    else if (confirm.value !== password.value) ok = setError(confirm, "Passwords do not match.");
    else setValid(confirm);

    if (!ok) return;

    setLoading(submitBtn, true, "Saving...");

    try {
      const { ok: success, data } = await postJSON("/api/auth/reset-password", {
        token,
        password: password.value
      });

      if (success) {
        showMessage("Password changed! Redirecting to login...", "success");
        setTimeout(() => (window.location.href = "login.html"), 1500);
        return;
      }
      showMessage(data.message || "This link is invalid or has expired.", "fail");
    } catch (err) {
      showMessage("Cannot reach the server. Make sure it is running.", "fail");
    }

    setLoading(submitBtn, false, "Reset password");
  });
}
