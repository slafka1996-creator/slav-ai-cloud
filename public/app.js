const $ = s => document.querySelector(s);
const messages = $("#messages");
const promptBox = $("#prompt");
let mode = "chat";
let conversationId = null;
let transcript = [];
let attachedFiles = [];
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
  if (!message && !attachedFiles.length) return;
  promptBox.value = "";
  promptBox.style.height = "auto";
  addMessage("user",message + (attachedFiles.length ? "\\n\\n📎 "+attachedFiles.map(f=>f.name).join(", ") : ""));
  const filesForRequest = attachedFiles.slice();
  attachedFiles = [];
  renderAttachments();
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
      body:JSON.stringify({message: message || "Проанализируй прикреплённые файлы.", attachmentContext: attachedFiles.map(f=>"ФАЙЛ: "+f.name+"\\n"+f.content).join("\\n\\n"), mode,conversationId})
    });
    const data = await res.json();
    waiting.remove();
    if (!res.ok) throw new Error(data.error || "Ошибка сервера");
    conversationId = data.conversationId || conversationId;
    addMessage("assistant",data.answer || "Пустой ответ");
    refreshChatHistory();
  } catch(e) {
    waiting.remove();
    addMessage("assistant",e.message,true);
  } finally {
    button.disabled = false;
    promptBox.focus();
  }
}
$("#sendBtn").addEventListener("click",send);
const fileInput=$("#fileInput");
function renderAttachments(){const box=$("#attachmentList");if(!box)return;box.hidden=!attachedFiles.length;box.replaceChildren();attachedFiles.forEach((f,i)=>{const chip=document.createElement("span");chip.className="attachment-chip";chip.textContent="📎 "+f.name+" ";const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.setAttribute("aria-label","Убрать "+f.name);remove.onclick=()=>{attachedFiles.splice(i,1);renderAttachments();};chip.append(remove);box.append(chip);});}
$("#attachBtn")?.addEventListener("click",()=>fileInput.click());
fileInput?.addEventListener("change",async()=>{for(const file of [...fileInput.files]){if(file.size>100000){alert(file.name+": максимум 100 КБ на файл.");continue;}try{const content=await file.text();if(content.includes("\\u0000")){alert(file.name+": бинарные файлы пока не поддерживаются.");continue;}attachedFiles.push({name:file.name,content});}catch{alert("Не удалось прочитать "+file.name);}}fileInput.value="";renderAttachments();});
promptBox.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
promptBox.addEventListener("input",()=>{promptBox.style.height="auto";promptBox.style.height=Math.min(promptBox.scrollHeight,180)+"px";});
async function startNewChat(){conversationId=null;transcript=[];messages.innerHTML='<div class="welcome" id="welcome"><div class="welcome-logo">S</div><h1>Привет! Я SLAV AI.</h1><p>Чем займёмся сегодня?</p><div class="suggestions"><button data-prompt="Помоги мне составить план проекта">Составить план проекта</button><button data-prompt="Напиши и объясни код для моей задачи">Помочь с программированием</button><button data-prompt="Объясни сложную тему простыми словами">Объяснить сложную тему</button></div></div>';  document.querySelectorAll('.workspace-tab').forEach(b=>b.classList.toggle('active',b.dataset.view==='chat'));
  showView('chat');promptBox.focus();
}
$('#newChat').addEventListener('click',startNewChat);
document.querySelectorAll(".mode").forEach(btn=>btn.addEventListener("click",()=>{mode=btn.dataset.mode;document.querySelectorAll(".mode").forEach(x=>x.classList.toggle("active",x===btn));$("#modeTitle").textContent=titles[mode];$("#menuBtn").closest("header");$(".sidebar").classList.remove("open");}));
messages.addEventListener("click",e=>{const btn=e.target.closest("[data-prompt]");if(btn){promptBox.value=btn.dataset.prompt;send();}});
$("#menuBtn").addEventListener("click",()=>$(".sidebar").classList.toggle("open"));
$("#exportBtn").addEventListener("click",()=>{const text=transcript.map(x=>(x.role==="user"?"Вы":"SLAV AI")+":\n"+x.text).join("\n\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type:"text/plain"}));a.download="slav-ai-chat.txt";a.click();URL.revokeObjectURL(a.href);});
fetch("/health").then(r=>r.json()).then(d=>{const dot=$("#statusDot");dot.classList.toggle("ok",d.openrouterConfigured || d.geminiConfigured);$("#statusText").textContent=(d.openrouterConfigured || d.geminiConfigured)?"AI подключён · GitHub "+(d.githubConfigured?"подключён":"не подключён"):"Нужен API-ключ";}).catch(()=>{$("#statusText").textContent="Нет связи с сервером";});

// Autonomous office is the primary developer workspace; no browser-side admin key.
async function devRequest(url, options={}) {
  const response=await fetch(url,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||("HTTP "+response.status));
  return data;
}
$("#devBtn")?.addEventListener("click",()=>document.querySelector(".office")?.scrollIntoView({behavior:"smooth",block:"start"}));
let latestCiFailure = null;
async function refreshCiStatus() {
  const panel=$("#ciStatus"), fix=$("#ciFix");
  try {
    const data=await devRequest("/api/ci/status");
    if(!data.found){panel.textContent=data.message||"Автотесты пока не запускались.";fix.hidden=true;return;}
    const run=data.run, jobs=data.jobs||[];
    const failed=jobs.flatMap(job=>(job.failedSteps||[]).map(step=>job.name+": "+step));
    if(run.status==="completed"&&run.conclusion==="success"){
      panel.textContent="✓ Автотесты пройдены · запуск #"+run.number;
      panel.dataset.state="success";fix.hidden=true;latestCiFailure=null;
    } else if(run.status==="completed"&&run.conclusion!=="success"){
      panel.textContent="✕ Автотесты завершились с ошибкой · "+(failed.join("; ")||run.conclusion);
      panel.dataset.state="failure";latestCiFailure={run,failed};fix.hidden=false;
    } else {
      panel.textContent="⏳ Автотесты выполняются · запуск #"+run.number;
      panel.dataset.state="running";fix.hidden=true;
    }
    panel.dataset.url=run.url||"";
  } catch(e){panel.textContent="Не удалось получить статус CI: "+e.message;fix.hidden=true;}
}
$("#ciFix")?.addEventListener("click",()=>{
  if(!latestCiFailure)return;
  const {run,failed}=latestCiFailure;
  $("#agentTask").value="Исправь ошибки последнего CI-прогона SLAV AI. Запуск #"+run.number+" ("+run.sha+"). Не ограничивайся описанием: изучи исходники, найди причину, подготовь исправления. Ошибочные шаги: "+(failed.join("; ")||"Смотри отчёт GitHub Actions.")+". После подготовки объясни, какие тесты нужно повторить. Отчёт: "+run.url;
  $("#agentTask").focus();
  $("#agentTask").scrollIntoView({behavior:"smooth",block:"center"});
});
refreshCiStatus();


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


// Workspace navigation, durable projects and interactive HTML artifacts.
let activeView = "chat";
let editingProjectId = null;
function showView(view) {
  activeView = view;
  document.querySelectorAll(".workspace-tab").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  $("#projectsView").hidden = view !== "projects";
  $("#artifactsView").hidden = view !== "artifacts";
  $("#messages").hidden = view !== "chat";
  $(".composer-wrap").hidden = view !== "chat";
  $(".office-main").hidden = view !== "chat";
  $("#modeTitle").textContent = view==="projects" ? "Проекты" : view==="artifacts" ? "Artifacts" : "Офис SLAV AI";
  if(view==="projects") loadProjects();
}
document.querySelectorAll(".workspace-tab").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
async function loadProjects(){
  const list=$("#projectList");
  list.innerHTML='<div class="empty-state">Загружаю проекты…</div>';
  try{
    const data=await devRequest("/api/projects");
    if(!data.projects?.length){list.innerHTML='<div class="empty-state">Пока нет проектов. Создай первый — его инструкции будут храниться отдельно.</div>';return;}
    list.replaceChildren();
    data.projects.forEach(p=>{
      const card=document.createElement("article");card.className="project-card";
      const h=document.createElement("h3");h.textContent=p.name;
      const d=document.createElement("p");d.textContent=p.description||"Без описания";
      const meta=document.createElement("small");meta.textContent="Обновлён: "+new Date(p.updated_at).toLocaleString("ru-RU");
      const actions=document.createElement("div");actions.className="project-actions";
      const open=document.createElement("button");open.className="primary-action";open.textContent="Открыть в чате";open.onclick=()=>{conversationId=null;transcript=[];messages.innerHTML="";showView("chat");promptBox.value="Работаем над проектом «"+p.name+"». Описание: "+p.description+". Инструкции проекта: "+p.instructions+". Учитывай этот контекст во всех ответах.";send();};
      const edit=document.createElement("button");edit.className="secondary-action";edit.textContent="Изменить";edit.onclick=()=>editProject(p);
      const del=document.createElement("button");del.className="secondary-action danger";del.textContent="Удалить";del.onclick=async()=>{if(!confirm("Удалить проект «"+p.name+"»?"))return;await devRequest("/api/projects/"+encodeURIComponent(p.id),{method:"DELETE"});loadProjects();};
      actions.append(open,edit,del);card.append(h,d,meta,actions);list.append(card);
    });
  }catch(e){list.textContent="Не удалось загрузить проекты: "+e.message;}
}
function editProject(p=null){
  editingProjectId=p?.id||null;$("#projectEditor").hidden=false;$("#projectEditorTitle").textContent=p?"Настройки проекта":"Новый проект";
  $("#projectName").value=p?.name||"";$("#projectDescription").value=p?.description||"";$("#projectInstructions").value=p?.instructions||"";$("#projectFeedback").textContent="";
  $("#projectName").focus();
}
$("#createProject").addEventListener("click",()=>editProject());
$("#cancelProject").addEventListener("click",()=>$("#projectEditor").hidden=true);
$("#saveProject").addEventListener("click",async()=>{
  const payload={name:$("#projectName").value.trim(),description:$("#projectDescription").value,instructions:$("#projectInstructions").value};
  if(!payload.name){$("#projectFeedback").textContent="Введи название проекта.";return;}
  const btn=$("#saveProject");btn.disabled=true;
  try{await devRequest(editingProjectId?"/api/projects/"+encodeURIComponent(editingProjectId):"/api/projects",{method:editingProjectId?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});$("#projectEditor").hidden=true;await loadProjects();}
  catch(e){$("#projectFeedback").textContent="Ошибка: "+e.message;}finally{btn.disabled=false;}
});
let currentArtifact="";
$("#generateArtifact").addEventListener("click",async()=>{
  const prompt=$("#artifactPrompt").value.trim();if(!prompt){$("#artifactStatus").textContent="Опиши, что нужно создать.";return;}
  const btn=$("#generateArtifact");btn.disabled=true;$("#artifactStatus").textContent="AI создаёт приложение…";
  try{const data=await devRequest("/api/artifact",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt})});currentArtifact=data.html;$("#artifactPreview").srcdoc=currentArtifact;$("#artifactTitle").textContent="Готовый артефакт";$("#downloadArtifact").disabled=false;$("#artifactStatus").textContent="Создано. Предпросмотр изолирован в sandbox.";}
  catch(e){$("#artifactStatus").textContent="Не удалось создать: "+e.message;}finally{btn.disabled=false;}
});
$("#downloadArtifact").addEventListener("click",()=>{if(!currentArtifact)return;const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([currentArtifact],{type:"text/html"}));a.download="slav-ai-artifact.html";a.click();URL.revokeObjectURL(a.href);});


// Chat history: load, search, rename and delete saved conversations.
async function refreshChatHistory(){
  const list=$("#chatHistory");if(!list)return;
  try{
    const rows=await devRequest("/api/conversations");
    const query=($("#chatSearch")?.value||"").trim().toLocaleLowerCase("ru");
    const filtered=rows.filter(x=>String(x.title||"Новый чат").toLocaleLowerCase("ru").includes(query));
    list.replaceChildren();
    if(!filtered.length){const empty=document.createElement("div");empty.className="history-empty";empty.textContent=query?"Ничего не найдено":"Здесь появятся сохранённые чаты";list.append(empty);return;}
    filtered.forEach(item=>{
      const row=document.createElement("div");row.className="history-row"+(item.id===conversationId?" active":"");
      const open=document.createElement("button");open.className="history-open";open.textContent=item.title||"Новый чат";open.title=item.title||"Новый чат";open.onclick=()=>loadConversation(item.id);
      const menu=document.createElement("button");menu.className="history-menu";menu.textContent="···";menu.setAttribute("aria-label","Действия с чатом");
      const actions=document.createElement("div");actions.className="history-actions";
      const rename=document.createElement("button");rename.textContent="Переименовать";rename.onclick=async()=>{const title=prompt("Новое название чата",item.title||"Новый чат");if(!title?.trim())return;try{await devRequest("/api/conversation/"+encodeURIComponent(item.id),{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({title:title.trim()})});refreshChatHistory();}catch(e){alert(e.message);}};
      const remove=document.createElement("button");remove.textContent="Удалить";remove.className="danger";remove.onclick=async()=>{if(!confirm("Удалить чат «"+(item.title||"Новый чат")+"»?"))return;try{await devRequest("/api/conversation/"+encodeURIComponent(item.id),{method:"DELETE"});if(conversationId===item.id)startNewChat();refreshChatHistory();}catch(e){alert(e.message);}};
      actions.append(rename,remove);menu.onclick=()=>{document.querySelectorAll(".history-actions.open").forEach(x=>{if(x!==actions)x.classList.remove("open")});actions.classList.toggle("open")};
      row.append(open,menu,actions);list.append(row);
    });
  }catch(e){list.textContent="История недоступна: "+e.message;}
}
async function loadConversation(id){
  try{
    const rows=await devRequest("/api/conversation?id="+encodeURIComponent(id));
    conversationId=id;transcript=[];messages.replaceChildren();
    rows.forEach(row=>addMessage(row.role,row.content));
    if(!rows.length)messages.innerHTML='<div class="welcome" id="welcome"><div class="welcome-logo">S</div><h1>Пустой чат</h1><p>Напиши первое сообщение.</p></div>';
    showView("chat");refreshChatHistory();promptBox.focus();
  }catch(e){alert("Не удалось открыть чат: "+e.message);}
}
$("#refreshChats")?.addEventListener("click",refreshChatHistory);
$("#chatSearch")?.addEventListener("input",refreshChatHistory);
refreshChatHistory();
