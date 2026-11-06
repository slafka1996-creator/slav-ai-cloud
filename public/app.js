const $ = s => document.querySelector(s);
const messages = $("#messages");
const promptBox = $("#prompt");
let mode = "chat";
let conversationId = null;
let transcript = [];
let attachedFiles = [];
let activeProjectId = null;
let activeChatController = null;
const titles = {chat:"Обычный чат",think:"Глубокий анализ",code:"Программирование",research:"Исследование"};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function renderMarkdown(source) {
  const blocks=[];
  let text=String(source||"").replace(/\r\n?/g,"\n").replace(/```([\w+-]*)\n([\s\S]*?)```/g,(_,lang,code)=>{
    const token="@@CODEBLOCK"+blocks.length+"@@";
    blocks.push({lang:lang||"code",code});
    return "\n"+token+"\n";
  });
  text=escapeHtml(text);
  text=text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text=text.replace(/`([^`\n]+)`/g,"<code>$1</code>");
  text=text.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>");
  text=text.replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<em>$2</em>");
  const lines=text.split("\n"),out=[];
  let listType=null;
  const closeList=()=>{if(listType){out.push(listType==="ul"?"</ul>":"</ol>");listType=null;}};
  for(const line of lines){
    const codeMatch=line.match(/^@@CODEBLOCK(\d+)@@$/);
    if(codeMatch){closeList();const b=blocks[Number(codeMatch[1])];out.push('<div class="code-block"><div class="code-toolbar"><span>'+escapeHtml(b.lang)+'</span><button type="button" class="copy-code">Копировать</button></div><pre><code>'+escapeHtml(b.code.replace(/\n$/,""))+'</code></pre></div>');continue;}
    const heading=line.match(/^(#{1,3})\s+(.+)$/);
    const bullet=line.match(/^\s*[-*]\s+(.+)$/);
    const numbered=line.match(/^\s*\d+[.)]\s+(.+)$/);
    if(bullet||numbered){const type=bullet?"ul":"ol";if(listType!==type){closeList();out.push(type==="ul"?"<ul>":"<ol>");listType=type;}out.push("<li>"+(bullet?bullet[1]:numbered[1])+"</li>");continue;}
    closeList();
    if(!line.trim()){out.push("");continue;}
    if(heading)out.push("<h"+heading[1].length+">"+heading[2]+"</h"+heading[1].length+">");
    else if(line.startsWith("&gt; "))out.push('<blockquote>'+line.slice(5)+'</blockquote>');
    else out.push("<p>"+line+"</p>");
  }
  closeList();
  return out.join("");
}
function addMessage(role, text, error=false) {
  $("#welcome")?.remove();
  transcript.push({role,text});
  const el = document.createElement("div");
  el.className = "message " + role + (error ? " error" : "");
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "Я" : "S";
  const content = document.createElement("div");
  content.className = "content markdown-content";
  content.innerHTML = renderMarkdown(text);
  el.append(avatar,content);
  messages.append(el);
  messages.scrollTop = messages.scrollHeight;
}
async function send() {
  const message = promptBox.value.trim();
  if (!message && !attachedFiles.length) return;
  promptBox.value = "";
  promptBox.style.height = "auto";
  addMessage("user",message + (attachedFiles.length ? "\n\n📎 "+attachedFiles.map(f=>f.name).join(", ") : ""));
  const filesForRequest = attachedFiles.slice();
  attachedFiles = [];
  renderAttachments();
  const button = $("#sendBtn");
  const stopButton = $("#stopBtn");
  const controller = new AbortController();
  activeChatController = controller;
  button.disabled = true;
  stopButton.hidden = false;
  const bubble = document.createElement("div");
  bubble.className = "message assistant";
  const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = "S";
  const content = document.createElement("div"); content.className = "content markdown-content"; content.textContent = "Думаю…";
  bubble.append(avatar,content); messages.append(bubble); messages.scrollTop = messages.scrollHeight;
  let answer = "";
  try {
    const res = await fetch("/api/chat", {
      method:"POST", headers:{"content-type":"application/json"}, signal:controller.signal,
      body:JSON.stringify({message: message || "Проанализируй прикреплённые файлы.", attachmentContext: filesForRequest.map(f=>"ФАЙЛ: "+f.name+"\n"+f.content).join("\n\n"), projectId:activeProjectId, mode,conversationId})
    });
    if (!res.ok) { const data=await res.json().catch(()=>({})); throw new Error(data.error || "Ошибка сервера"); }
    if (!res.body) throw new Error("Браузер не поддерживает потоковый ответ.");
    const reader=res.body.getReader(), decoder=new TextDecoder(); let buffer="", finished=false;
    const processEvent=(raw)=>{
      let event="message",payload="";
      for(const line of raw.split("\n")){if(line.startsWith("event:"))event=line.slice(6).trim();else if(line.startsWith("data:"))payload+=line.slice(5).trim();}
      if(!payload)return;
      const data=JSON.parse(payload);
      if(event==="delta"){answer+=data.text||"";content.innerHTML=renderMarkdown(answer);messages.scrollTop=messages.scrollHeight;}
      else if(event==="done"){conversationId=data.conversationId||conversationId;finished=true;}
      else if(event==="error")throw new Error(data.error||"Ошибка генерации.");
    };
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const chunks=buffer.split("\n\n");buffer=chunks.pop()||"";for(const chunk of chunks)processEvent(chunk);}
    if(buffer.trim())processEvent(buffer);
    if(!finished)throw new Error(answer?"Поток завершился до подтверждения сохранения ответа.":"Модель не вернула ответ.");
    if(!answer.trim())content.textContent="Пустой ответ";
    transcript.push({role:"assistant",text:answer});
    refreshChatHistory();
  } catch(e) {
    if(e.name==="AbortError") {
      if(answer){content.innerHTML=renderMarkdown(answer+"\n\n*Генерация остановлена.*");transcript.push({role:"assistant",text:answer});}
      else {bubble.remove();addMessage("assistant","Генерация остановлена.");}
    } else if(answer){content.innerHTML=renderMarkdown(answer+"\n\n⚠️ "+e.message);transcript.push({role:"assistant",text:answer});}
    else {bubble.remove();addMessage("assistant",e.message,true);}
  } finally {if(activeChatController===controller)activeChatController=null;button.disabled=false;stopButton.hidden=true;promptBox.focus();}
}
$("#sendBtn").addEventListener("click",send);
$("#stopBtn").addEventListener("click",()=>activeChatController?.abort());
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
messages.addEventListener("click",async e=>{const button=e.target.closest(".copy-code");if(!button)return;const code=button.closest(".code-block")?.querySelector("code")?.textContent||"";try{await navigator.clipboard.writeText(code);button.textContent="Скопировано";setTimeout(()=>button.textContent="Копировать",1400);}catch{button.textContent="Не удалось";}});
$("#menuBtn").addEventListener("click",()=>$(".sidebar").classList.toggle("open"));
$("#exportBtn").addEventListener("click",()=>{const text=transcript.map(x=>(x.role==="user"?"Вы":"SLAV AI")+":\n"+x.text).join("\n\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type:"text/plain"}));a.download="slav-ai-chat.txt";a.click();URL.revokeObjectURL(a.href);});
fetch("/health").then(r=>r.json()).then(d=>{const dot=$("#statusDot");dot.classList.toggle("ok",d.openrouterConfigured || d.geminiConfigured);$("#statusText").textContent=(d.openrouterConfigured || d.geminiConfigured)?"AI подключён · GitHub "+(d.githubConfigured?"подключён":"не подключён"):"Нужен API-ключ";}).catch(()=>{$("#statusText").textContent="Нет связи с сервером";});

// Shared API helper for projects and workspace features.
async function devRequest(url, options={}) {
  const response=await fetch(url,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||("HTTP "+response.status));
  return data;
}


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
  $("#modeTitle").textContent = view==="projects" ? "Проекты" : view==="artifacts" ? "Artifacts" : "SLAV AI";
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
      const open=document.createElement("button");open.className="primary-action";open.textContent="Открыть в чате";open.onclick=()=>{activeProjectId=p.id;conversationId=null;transcript=[];messages.innerHTML="";showView("chat");promptBox.value="Открой рабочий контекст проекта и кратко подтверди, что понял его цели, структуру и инструкции. Предложи следующий практический шаг.";send();};
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
