// Only our build-generated manifest and locally cached avatars are requested.
(async function () {
  const wall = document.querySelector('[data-contributors]');
  const status = document.querySelector('[data-contributors-status]');
  if (!wall || !status) return;
  try {
    const response = await fetch('/contributors.json');
    if (!response.ok) throw new Error('Contributors unavailable');
    const data = await response.json();
    if (!data.available || !Array.isArray(data.contributors) || !data.contributors.length) return;
    const fragment = document.createDocumentFragment();
    for (const person of data.contributors) {
      if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(person.login || '')) continue;
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'contributor-avatar';
      link.href = `https://github.com/${person.login}`;
      link.setAttribute('aria-label', `${person.login} on GitHub`);
      const initials = document.createElement('span');
      initials.className = 'contributor-initials';
      initials.setAttribute('aria-hidden', 'true');
      initials.textContent = person.login.slice(0, 2).toUpperCase();
      link.append(initials);
      if (new RegExp(`^/contributors/${person.login}\\.(png|jpg|webp)$`, 'i').test(person.avatar || '')) {
        const image = document.createElement('img');
        image.src = person.avatar;
        image.alt = '';
        image.width = image.height = 56;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => image.remove(), { once: true });
        link.append(image);
      }
      const name = document.createElement('span');
      name.className = 'contributor-name';
      name.textContent = person.login;
      name.setAttribute('aria-hidden', 'true');
      link.append(name);
      item.append(link);
      fragment.append(item);
    }
    if (!fragment.childNodes.length) return;
    const count = fragment.childNodes.length;
    wall.append(fragment);
    wall.hidden = false;
    status.textContent = `${count} ${count === 1 ? 'contributor' : 'contributors'} · From GitHub, refreshed with each site build`;
  } catch {
    // The thank-you, contribution guide and GitHub list work without this script.
  }
})();
