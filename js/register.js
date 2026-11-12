// ---------- Country list (name, dial code) ----------
const COUNTRIES = [
  ["Ethiopia", "+251"], ["Kenya", "+254"], ["Uganda", "+256"], ["Tanzania", "+255"],
  ["Rwanda", "+250"], ["Somalia", "+252"], ["Djibouti", "+253"], ["Eritrea", "+291"],
  ["Sudan", "+249"], ["South Sudan", "+211"], ["Egypt", "+20"], ["Nigeria", "+234"],
  ["Ghana", "+233"], ["South Africa", "+27"], ["Morocco", "+212"], ["Algeria", "+213"],
  ["Saudi Arabia", "+966"], ["United Arab Emirates", "+971"], ["Qatar", "+974"],
  ["Kuwait", "+965"], ["Turkey", "+90"], ["India", "+91"], ["China", "+86"],
  ["Japan", "+81"], ["South Korea", "+82"], ["Pakistan", "+92"], ["Bangladesh", "+880"],
  ["Indonesia", "+62"], ["Philippines", "+63"], ["United Kingdom", "+44"],
  ["Ireland", "+353"], ["Germany", "+49"], ["France", "+33"], ["Italy", "+39"],
  ["Spain", "+34"], ["Netherlands", "+31"], ["Sweden", "+46"], ["Norway", "+47"],
  ["Russia", "+7"], ["United States", "+1"], ["Canada", "+1"], ["Mexico", "+52"],
  ["Brazil", "+55"], ["Argentina", "+54"], ["Australia", "+61"], ["New Zealand", "+64"]
];

// ---------- Elements ----------
const form = document.getElementById("registerForm");
const countrySelect = document.getElementById("country");
const dialCode = document.getElementById("dialCode");
const fileInput = document.getElementById("profilePicture");
const avatarImg = document.getElementById("avatarImg");
const avatarPlaceholder = document.getElementById("avatarPlaceholder");
const pictureError = document.getElementById("profilePictureError");
const passwordInput = document.getElementById("password");
const strengthBar = document.getElementById("strengthBar");
const strengthText = document.getElementById("strengthText");
const submitBtn = document.getElementById("submitBtn");
const formMessage = document.getElementById("formMessage");

const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB
const MIN_AGE = 18;

// ---------- Fill countries ----------
COUNTRIES.forEach(([name, code]) => {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  option.dataset.dial = code;
  countrySelect.appendChild(option);
});

countrySelect.addEventListener("change", () => {
  const selected = countrySelect.options[countrySelect.selectedIndex];
  dialCode.textContent = selected.dataset.dial || "+000";
});

// ---------- Birthday limits ----------
const birthdayInput = document.getElementById("birthday");
(function setBirthdayLimits() {
  const today = new Date();
  const max = new Date(today.getFullYear() - MIN_AGE, today.getMonth(), today.getDate());
  const min = new Date(today.getFullYear() - 100, today.getMonth(), today.getDate());
  birthdayInput.max = max.toISOString().split("T")[0];
  birthdayInput.min = min.toISOString().split("T")[0];
})();

// ---------- Profile picture preview ----------
fileInput.addEventListener("change", () => {
  pictureError.textContent = "";
  const file = fileInput.files[0];

  if (!file) {
    resetAvatar();
    return;
  }

  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.type)) {
    pictureError.textContent = "Only JPG, PNG or WEBP images are allowed.";
    fileInput.value = "";
    resetAvatar();
    return;
  }
  if (file.size > MAX_IMAGE_SIZE) {
    pictureError.textContent = "Image must be 2MB or smaller.";
    fileInput.value = "";
    resetAvatar();
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    avatarImg.src = e.target.result;
    avatarImg.hidden = false;
    avatarPlaceholder.hidden = true;
  };
  reader.readAsDataURL(file);
});

function resetAvatar() {
  avatarImg.removeAttribute("src");
  avatarImg.hidden = true;
  avatarPlaceholder.hidden = false;
}

// ---------- Show / hide password ----------
document.querySelectorAll(".toggle-pass").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
  });
});

// ---------- Password strength ----------
passwordInput.addEventListener("input", () => {
  const value = passwordInput.value;
  let score = 0;
  if (value.length >= 8) score++;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;

  const levels = [
    { width: "0%", color: "transparent", text: "" },
    { width: "25%", color: "#dc2626", text: "Weak" },
    { width: "50%", color: "#f59e0b", text: "Fair" },
    { width: "75%", color: "#0ea5e9", text: "Good" },
    { width: "100%", color: "#16a34a", text: "Strong" }
  ];
  const level = value ? levels[score] || levels[1] : levels[0];
  strengthBar.style.width = level.width;
  strengthBar.style.background = level.color;
  strengthText.textContent = level.text;
});

// ---------- Validation helpers ----------
function setError(input, message) {
  const field = input.closest(".field");
  const errorEl = field.querySelector(".error");
  field.classList.remove("valid");
  field.classList.add("invalid");
  errorEl.textContent = message;
  return false;
}

function setValid(input) {
  const field = input.closest(".field");
  const errorEl = field.querySelector(".error");
  field.classList.remove("invalid");
  field.classList.add("valid");
  errorEl.textContent = "";
  return true;
}

function getAge(dateString) {
  const birth = new Date(dateString);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function validateForm() {
  let ok = true;
  const f = form.elements;

  // Names
  ["firstName", "lastName"].forEach((name) => {
    const input = f[name];
    const value = input.value.trim();
    if (value.length < 2) ok = setError(input, "Please enter at least 2 characters.");
    else if (!/^[\p{L}\s'-]+$/u.test(value)) ok = setError(input, "Letters only, please.");
    else setValid(input);
  });

  // Email
  const email = f.email.value.trim();
  if (!email) ok = setError(f.email, "Email is required.");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) ok = setError(f.email, "Enter a valid email address.");
  else setValid(f.email);

  // Birthday
  if (!f.birthday.value) ok = setError(f.birthday, "Birthday is required.");
  else if (getAge(f.birthday.value) < MIN_AGE) ok = setError(f.birthday, "You must be at least " + MIN_AGE + " years old.");
  else setValid(f.birthday);

  // Gender
  if (!f.gender.value) ok = setError(f.gender, "Select your gender.");
  else setValid(f.gender);

  // Country / City / Address
  if (!f.country.value) ok = setError(f.country, "Select your country.");
  else setValid(f.country);

  if (f.city.value.trim().length < 2) ok = setError(f.city, "Enter your city.");
  else setValid(f.city);

  if (f.address.value.trim().length < 5) ok = setError(f.address, "Enter your address.");
  else setValid(f.address);

  // Phone
  const phone = f.phone.value.replace(/[\s-]/g, "");
  if (!/^\d{7,12}$/.test(phone)) ok = setError(f.phone, "Enter 7 to 12 digits (without country code).");
  else setValid(f.phone);

  // Password
  const pass = f.password.value;
  if (pass.length < 8) ok = setError(f.password, "Password must be at least 8 characters.");
  else if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) ok = setError(f.password, "Use letters and numbers.");
  else setValid(f.password);

  if (!f.confirmPassword.value) ok = setError(f.confirmPassword, "Confirm your password.");
  else if (f.confirmPassword.value !== pass) ok = setError(f.confirmPassword, "Passwords do not match.");
  else setValid(f.confirmPassword);

  // Terms
  if (!f.terms.checked) ok = setError(f.terms, "You must accept the terms.");
  else setValid(f.terms);

  return ok;
}

function showMessage(text, type) {
  formMessage.textContent = text;
  formMessage.className = "form-message show " + type;
}

// ---------- Submit ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formMessage.className = "form-message";

  if (!validateForm()) {
    const firstInvalid = form.querySelector(".field.invalid");
    if (firstInvalid) firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const data = new FormData();
  data.append("role", form.elements.role.value);
  data.append("firstName", form.elements.firstName.value.trim());
  data.append("lastName", form.elements.lastName.value.trim());
  data.append("email", form.elements.email.value.trim().toLowerCase());
  data.append("birthday", form.elements.birthday.value);
  data.append("gender", form.elements.gender.value);
  data.append("country", form.elements.country.value);
  data.append("city", form.elements.city.value.trim());
  data.append("address", form.elements.address.value.trim());
  data.append("phone", dialCode.textContent + form.elements.phone.value.replace(/[\s-]/g, ""));
  data.append("password", form.elements.password.value);
  if (fileInput.files[0]) data.append("profilePicture", fileInput.files[0]);

  submitBtn.disabled = true;
  submitBtn.textContent = "Creating account...";

  try {
    const response = await fetch("/api/auth/register", { method: "POST", body: data });
    const result = await response.json().catch(() => ({}));

    if (response.ok) {
      showMessage("Account created! Redirecting to login...", "success");
      setTimeout(() => (window.location.href = "login.html"), 1500);
    } else {
      showMessage(result.message || "Registration failed. Please try again.", "fail");
    }
  } catch (err) {
    showMessage("Cannot reach the server yet. We will connect it in the next step.", "fail");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create account";
  }
});
