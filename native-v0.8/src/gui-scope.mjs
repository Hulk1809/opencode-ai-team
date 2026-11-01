// UI lifetime only; never an authenticated principal or execution fence.
export function guiScope(){
  let generation=0,disposed=false;
  return {
    invalidate(){generation++;},
    dispose(){disposed=true;generation++;},
    capture(){const at=generation;return ()=>!disposed&&at===generation;},
  };
}
