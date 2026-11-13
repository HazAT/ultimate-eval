export function matchesName(recipe, query) {
  return recipe.name.toLowerCase().includes(query)
}
