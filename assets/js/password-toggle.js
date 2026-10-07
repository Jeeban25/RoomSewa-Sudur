document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-password-toggle]");
  if (!toggle) return;

  const input = document.getElementById(toggle.dataset.passwordToggle);
  if (!(input instanceof HTMLInputElement)) return;

  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(visible));
  toggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");

  const icon = toggle.querySelector("i");
  if (icon) icon.className = visible ? "bi bi-eye-slash" : "bi bi-eye";
});

document.addEventListener("reset", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  window.setTimeout(() => {
    form.querySelectorAll("[data-password-toggle]").forEach((toggle) => {
      const input = document.getElementById(toggle.dataset.passwordToggle);
      if (!(input instanceof HTMLInputElement)) return;

      input.type = "password";
      toggle.setAttribute("aria-pressed", "false");
      toggle.setAttribute("aria-label", "Show password");
      const icon = toggle.querySelector("i");
      if (icon) icon.className = "bi bi-eye";
    });
  }, 0);
});
