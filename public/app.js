const $ = s => document.querySelector(s);
const messages = $("#messages");
const promptBox = $("#prompt");
let mode = "chat";
let conversationId = null;
let transcript = [];
const titles = {chat:"Обычный чат",think:"Глубокий анализ",code:"Программирование",research:"Исследование"};

function addMessage(role, text, error=false) {
  $("#welcome")?.remove();
  transcript.push({role,text});
  const el = document.createElement("div");
  el.className = "message " + role + (error ? " error" : "");
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "Я" : "S";
  const content = document.createElement("div");
  content.className = "content";
  content.textContent = text;
  el.append(avatar,content);
  messages.append(el);
  messages.scrollTop = messages.scrollHeight;
}
async function send() {
  const message = promptBox.value.trim();
  if (!message) return;
  promptBox.value = "";
  promptBox.style.height = "auto";
  addMessage("user",message);
  const button = $("#sendBtn");
  button.disabled = true;
  const waiting = document.createElement("div");
  waiting.className = "message";
  waiting.innerHTML = '<div class="avatar">S</div><div class="content">Думаю…</div>';
  messages.append(waiting);
  messages.scrollTop = messages.scrollHeight;
  try {
    const res = await fetch("/api/chat", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({message,mode,conversationId})
    });
    const data = await res.json();
    waiting.remove();
    if (!res.ok) throw new Error(data.error || "Ошибка сервера");
    conversationId = data.conversationId || conversationId;
    addMessage("assistant",data.answer || "Пустой ответ");
  } catch(e) {
    waiting.remove();
    addMessage("assistant",e.message,true);
  } finally {
    button.disabled = false;
    promptBox.focus();
  }
}
$("#sendBtn").addEventListener("click",send);
promptBox.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
promptBox.addEventListener("input",()=>{promptBox.style.height="auto";promptBox.style.height=Math.min(promptBox.scrollHeight,180)+"px";});
$("#newChat").addEventListener("click",()=>{conversationId=null;transcript=[];messages.innerHTML='<div class="welcome" id="welcome"><div class="welcome-logo">S</div><h1>Привет! Я SLAV AI.</h1><p>Чем займёмся сегодня?</p><div class="suggestions"><button data-prompt="Помоги мне составить план проекта">Составить план проекта</button><button data-prompt="Напиши и объясни код для моей задачи">Помочь с программированием</button><button data-prompt="Объясни сложную тему простыми словами">Объяснить сложную тему</button></div></div>';});
document.querySelectorAll(".mode").forEach(btn=>btn.addEventListener("click",()=>{mode=btn.dataset.mode;document.querySelectorAll(".mode").forEach(x=>x.classList.toggle("active",x===btn));$("#modeTitle").textContent=titles[mode];$("#menuBtn").closest("header");$(".sidebar").classList.remove("open");}));
messages.addEventListener("click",e=>{const btn=e.target.closest("[data-prompt]");if(btn){promptBox.value=btn.dataset.prompt;send();}});
$("#menuBtn").addEventListener("click",()=>$(".sidebar").classList.toggle("open"));
$("#exportBtn").addEventListener("click",()=>{const text=transcript.map(x=>(x.role==="user"?"Вы":"SLAV AI")+":\n"+x.text).join("\n\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type:"text/plain"}));a.download="slav-ai-chat.txt";a.click();URL.revokeObjectURL(a.href);});
fetch("/health").then(r=>r.json()).then(d=>{const dot=$("#statusDot");dot.classList.toggle("ok",d.openrouterConfigured || d.geminiConfigured);$("#statusText").textContent=(d.openrouterConfigured || d.geminiConfigured)?"AI подключён · GitHub "+(d.githubConfigured?"подключён":"не подключён"):"Нужен API-ключ";}).catch(()=>{$("#statusText").textContent="Нет связи с сервером";});

// Protected GitHub developer workspace. Admin key stays only in page memory.
let devAdminKey = "";
const devPanel = $("#devPanel");
const devStatus = $("#devStatus");
const devHeaders = () => ({ "content-type":"application/json", "x-slav-admin-key":devAdminKey });
const devSay = text => { devStatus.textContent = text; };
async function devRequest(url, options={}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || ("HTTP "+response.status));
  return data;
}
$("#devBtn").addEventListener("click",()=>{devPanel.hidden=false;});
$("#devClose").addEventListener("click",()=>{devPanel.hidden=true;devAdminKey="";$("#devKey").value="";devSay("Ключ очищен из памяти страницы.");});
$("#devKey").addEventListener("input",e=>{devAdminKey=e.target.value.trim();});
$("#repoRefresh").addEventListener("click",async()=>{
  try{
    const data=await devRequest("/api/github/tree");
    const list=$("#repoTree");list.replaceChildren();
    for(const item of data.items||[]){
      const line=document.createElement("div");
      line.textContent=(item.type==="dir"?"📁 ":"📄 ")+item.path;
      if(item.type==="file"){line.tabIndex=0;line.style.cursor="pointer";line.addEventListener("click",()=>{$("#devPath").value=item.path;});}
      list.append(line);
    }
    devSay("Получено элементов: "+(data.items||[]).length);
  }catch(e){devSay(e.message);}
});
$("#fileLoad").addEventListener("click",async()=>{
  const path=$("#devPath").value.trim();if(!path){devSay("Укажи путь к файлу.");return;}
  try{const data=await devRequest("/api/github/file?path="+encodeURIComponent(path));$("#devContent").value=data.content;devSay("Файл загружен: "+data.path+" · SHA "+data.sha);}
  catch(e){devSay(e.message);}
});
$("#fileStage").addEventListener("click",async()=>{
  if(!devAdminKey){devSay("Сначала введи ключ администратора.");return;}
  const path=$("#devPath").value.trim(),content=$("#devContent").value;
  if(!path){devSay("Укажи путь к файлу.");return;}
  try{
    const staged=await devRequest("/api/github/write/stage",{method:"POST",headers:devHeaders(),body:JSON.stringify({path,content})});
    devSay("Изменение подготовлено: "+staged.path+" · "+staged.characters+" символов. Оно ещё НЕ опубликовано.");
    $("#stagedRefresh").click();
  }catch(e){devSay(e.message);}
});
$("#stagedRefresh").addEventListener("click",async()=>{
  if(!devAdminKey){devSay("Сначала введи ключ администратора.");return;}
  try{
    const data=await devRequest("/api/github/write/staged",{headers:{"x-slav-admin-key":devAdminKey}});
    const list=$("#stagedList");list.replaceChildren();
    const rows=data.staged||[];
    for(const item of rows){const line=document.createElement("div");line.textContent="📝 "+item.path+" · "+item.characters+" символов";list.append(line);}
    devSay(rows.length?"Подготовлено файлов: "+rows.length:"Очередь изменений пуста.");
  }catch(e){devSay(e.message);}
});
$("#devCommit").addEventListener("click",async()=>{
  if(!devAdminKey){devSay("Сначала введи ключ администратора.");return;}
  if(!confirm("ВНИМАНИЕ: отправить все подготовленные изменения прямо в main?"))return;
  const message=prompt("Название коммита:","Update files via SLAV AI");
  if(message===null)return;
  try{
    const data=await devRequest("/api/github/write/commit",{method:"POST",headers:devHeaders(),body:JSON.stringify({confirm:true,message})});
    devSay("Коммит создан: "+data.commit+"\nФайлы: "+(data.files||[]).join(", "));
    $("#stagedRefresh").click();
  }catch(e){devSay(e.message);}
});

$("#agentRun").addEventListener("click",async()=>{
  const task=$("#agentTask").value.trim();
  if(!task){$("#agentResult").textContent="Опиши задачу для агента.";return;}
  const btn=$("#agentRun"),floor=document.querySelector(".office-floor");btn.disabled=true;floor.classList.add("busy");
  $("#devAgentState").textContent="Получает задачу…";$("#designAgentState").textContent="Ожидает распределения";$("#testAgentState").textContent="Ожидает код";
  $("#agentResult").textContent="Диспетчер принимает задачу и направляет её разработчику…";
  try{
    const data=await devRequest("/api/agent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({task})});
    $("#devAgentState").textContent=(data.staged||[]).length?"Подготовил изменения":"Закончил анализ";
    $("#designAgentState").textContent="Модуль в разработке";
    $("#testAgentState").textContent="Модуль в разработке";
    const team=data.team||{};
    $("#designAgentState").textContent=team.designer?"Проверил UI":"Нет изменений для проверки";
    $("#testAgentState").textContent=team.tester?"Провёл статический QA":"Нет изменений для проверки";
    $("#agentResult").textContent=(data.answer||"Готово.")+"\n\n🎨 UI DESIGNER\n"+(team.designer||"Проверка не запускалась.")+"\n\n🧪 BROWSER TESTER / QA\n"+(team.tester||"Проверка не запускалась.")+"\n\n📁 Подготовленные файлы:\n"+((data.staged||[]).map(x=>x.path+" ("+x.characters+" символов)").join("\n")||"Нет");
  }catch(e){$("#agentResult").textContent="Ошибка агента: "+e.message;}
  finally{btn.disabled=false;floor.classList.remove("busy");}
});
