const saved = new Set(JSON.parse(localStorage.getItem('favourites') || '[]'))

export function setupFavourites(badge) {
  badge.textContent = '0'
}

export function favouriteButton(recipe, badge) {
  const button = document.createElement('button')
  const update = () => {
    button.textContent = saved.has(recipe.id) ? '★ Favourite' : '☆ Favourite'
    button.setAttribute('aria-pressed', String(saved.has(recipe.id)))
  }
  update()
  button.addEventListener('click', () => {
    if (saved.has(recipe.id)) saved.delete(recipe.id)
    else saved.add(recipe.id)
    localStorage.setItem('favourites', JSON.stringify([...saved]))
    badge.textContent = String(saved.size)
    update()
  })
  return button
}
