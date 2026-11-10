export function routingOptions(catalog,provider,query){
  const text=query.trim().toLowerCase();
  return catalog.filter(m=>(!provider||m.providerID===provider)&&`${m.id} ${m.name??''}`.toLowerCase().includes(text))
    .flatMap(m=>m.variants.length?m.variants.map(variant=>({providerID:m.providerID,id:m.id,variant})):[{providerID:m.providerID,id:m.id}]);
}
