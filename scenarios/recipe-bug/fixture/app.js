import { recipes } from './recipes.js'
import { matchesName } from './search.js'
import { setupFavourites, favouriteButton } from './favourites.js'

const list = document.getElementById('list')
const search = document.getElementById('search')
const badge = document.getElementById('favourites-count')
setupFavourites(badge)

function render() {
  list.replaceChildren()
  for (const recipe of recipes.filter((recipe) => matchesName(recipe, search.value))) {
    const item = document.createElement('li')
    item.append(`${recipe.name} (${recipe.minutes} min) `, favouriteButton(recipe, badge))
    list.append(item)
  }
}
search.addEventListener('input', render)
render()
