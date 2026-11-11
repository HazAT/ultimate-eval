import { recipes } from './recipes.js'

const list = document.getElementById('list')
for (const recipe of recipes) {
  const item = document.createElement('li')
  item.textContent = `${recipe.name} (${recipe.minutes} min)`
  list.append(item)
}
