let room='lobby',state=null,busy=false;
const $=id=>document.getElementById(id);
function render(){
  $('board').replaceChildren();for(let row=0;row<6;row++)for(let col=0;col<5;col++){
    const cell=document.createElement('div'),guess=state.guesses[row];cell.className='tile '+(guess?.marks[col]||'');cell.textContent=guess?.word[col].toUpperCase()||'';$('board').append(cell);
  }
  $('reset').hidden=!state.over;$('submit').disabled=state.over||busy;
  $('message').textContent=state.won?'Your room solved it!':state.over?'The word was '+state.answer.toUpperCase()+'.':'Room: '+room+' · '+(6-state.guesses.length)+' guesses left. Updates are shared with everyone.';
}
async function refresh(){try{const r=await fetch('/_wordle/'+room);if(r.status===401){location.reload();return}if(!r.ok)throw Error();state=await r.json();render()}catch{$('message').textContent='Connection interrupted. Reconnecting…'}}
async function send(data){if(busy||!state)return;busy=true;try{const r=await fetch('/_wordle/'+room,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:state.version,...data})});if(r.status===401){location.reload();return}if(r.status===409){await refresh();$('message').textContent='Someone else played first. Review the board and try again.';return}if(!r.ok)throw Error();state=await r.json();$('guess').value='';render()}catch{$('message').textContent='Could not submit that move. Try again.'}finally{busy=false;$('submit').disabled=!!state?.over}}
$('guess-form').addEventListener('submit',e=>{e.preventDefault();send({guess:$('guess').value.trim().toLowerCase()})});
$('reset').addEventListener('click',()=>send({reset:true}));
$('join').addEventListener('click',()=>{const next=$('room').value.trim();if(!/^[a-zA-Z0-9_-]{1,64}$/.test(next)){$('message').textContent='Use letters, numbers, underscores or hyphens for the room name.';return}room=next;state=null;refresh()});
refresh();setInterval(()=>{if(!busy)refresh()},2000);
