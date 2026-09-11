const GITHUB_REPOS_URL =
  "https://api.github.com/users/berkyuo2-cpu/repos?sort=updated&per_page=20";

function setCopyState(button, ok) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = ok ? "Kopyalandı" : "Kopyalanamadı";
  button.classList.toggle("copied", ok);
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
  }, 1600);
}

async function copyTemplate(button) {
  const targetId = button.getAttribute("data-copy");
  const node = targetId ? document.getElementById(targetId) : null;
  const text = node ? node.textContent.trim() : "";
  if (!text) {
    setCopyState(button, false);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setCopyState(button, true);
  } catch {
    setCopyState(button, false);
  }
}

function renderRepos(repos) {
  const root = document.getElementById("repo-list");
  if (!root || !Array.isArray(repos) || repos.length === 0) {
    return;
  }
  root.replaceChildren();
  for (const repo of repos) {
    if (!repo || repo.private || !repo.html_url || !repo.name) {
      continue;
    }
    const link = document.createElement("a");
    link.className = "card";
    link.href = repo.html_url;
    const description = repo.description ? ` — ${repo.description}` : "";
    link.textContent = `${repo.name}${description}`;
    root.append(link);
  }
}

async function loadPublicRepos() {
  try {
    const response = await fetch(GITHUB_REPOS_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      return;
    }
    const repos = await response.json();
    renderRepos(repos);
  } catch {
    // Keep the static fallback cards already in the HTML.
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-copy]");
  if (!button) {
    return;
  }
  copyTemplate(button);
});

loadPublicRepos();
