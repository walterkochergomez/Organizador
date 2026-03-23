import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// --- 🔥 CONFIGURACIÓN DE FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyAjWtEeVUDQFrPYGXRpRxK9J_Gf4M77lyw",
  authDomain: "organizador-academico-35d9d.firebaseapp.com",
  projectId: "organizador-academico-35d9d",
  storageBucket: "organizador-academico-35d9d.firebasestorage.app",
  messagingSenderId: "191522787552",
  appId: "1:191522787552:web:db08851e1d472ebb628085"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');
// Fuerza la pantalla de permisos (para evitar la casilla desmarcada)
provider.setCustomParameters({ prompt: 'consent select_account' });

const tasksRef = collection(db, "academicTasks");
let currentUser = null; 
let accessToken = localStorage.getItem('googleDriveToken');
let unsubscribeSnapshot = null;

// Referencias DOM Globales
const mainTaskList = document.getElementById('task-list');

document.addEventListener('DOMContentLoaded', () => {
    // Referencias DOM
    const taskForm = document.getElementById('task-form');
    const filterSubject = document.getElementById('filter-subject');
    const submitBtn = document.getElementById('submit-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    const btnExport = document.getElementById('btn-export');
    const btnExportIcs = document.getElementById('btn-export-ics');
    const importIcsInput = document.getElementById('import-ics-input');
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const loginOverlay = document.getElementById('login-overlay');
    const userNameDisplay = document.getElementById('user-name-display');
    const statusDisplay = document.getElementById('upload-status');
    const monthYearDisplay = document.getElementById('month-year');
    const calendarDays = document.getElementById('calendar-days');

    // Referencias de Modals y Asistente (Diseño Minimalista)
    const fabAddTask = document.getElementById('fab-add-task');
    const taskModal = document.getElementById('task-modal');
    const closeTaskModal = document.getElementById('close-task-modal');
    const modalTitle = document.getElementById('modal-title');
    
    const aiAssistantToggle = document.getElementById('ai-assistant-toggle');
    const aiAssistantMenu = document.getElementById('ai-assistant-menu');

    let tasks = []; 
    let editingId = null;
    let selectedDateFilter = null; 
    let currentDate = new Date();
    let currentMonth = currentDate.getMonth();
    let currentYear = currentDate.getFullYear();

    initTheme();

    // --- AUTENTICACIÓN ---
    onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUser = user;
            loginOverlay.classList.add('hidden');
            userNameDisplay.textContent = user.displayName;
            loadUserTasks();
        } else {
            currentUser = null;
            loginOverlay.classList.remove('hidden');
            tasks = [];
            updateDashboard();
            if (unsubscribeSnapshot) unsubscribeSnapshot();
            localStorage.removeItem('googleDriveToken');
            accessToken = null;
        }
    });

    btnLogin.addEventListener('click', async () => {
        btnLogin.textContent = 'Conectando...';
        try {
            const result = await signInWithPopup(auth, provider);
            const credential = GoogleAuthProvider.credentialFromResult(result);
            accessToken = credential.accessToken; 
            localStorage.setItem('googleDriveToken', accessToken);
        } catch (error) {
            alert("Error al iniciar sesión.");
            btnLogin.textContent = 'Ingresar con Google';
        }
    });

    btnLogout.addEventListener('click', () => { signOut(auth); });

    // --- LÓGICA DE INTERFAZ (Modals y Menús flotantes) ---
    fabAddTask.addEventListener('click', () => { openTaskModal('Nueva Tarea'); });
    closeTaskModal.addEventListener('click', () => { closeCurrentTaskModal(); });
    
    taskModal.addEventListener('click', (e) => {
        if (e.target === taskModal) closeCurrentTaskModal();
    });

    aiAssistantToggle.addEventListener('click', (e) => {
        e.stopPropagation(); 
        aiAssistantMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!aiAssistantMenu.contains(e.target) && !aiAssistantMenu.classList.contains('hidden')) {
            aiAssistantMenu.classList.add('hidden');
        }
    });

    function openTaskModal(title, taskId = null) {
        modalTitle.textContent = title;
        editingId = taskId;
        taskModal.classList.remove('hidden');
        document.body.classList.add('modal-open');
    }

    function closeCurrentTaskModal() {
        taskModal.classList.add('hidden');
        document.body.classList.remove('modal-open');
        taskForm.reset();
        exitEditMode();
    }

    // --- LÓGICA DE GOOGLE DRIVE (Con manejo de expiración de 1 hora) ---
    async function uploadToDrive(file, folderName) {
        if (!accessToken) return null;
        try {
            statusDisplay.textContent = `☁️ Subiendo "${file.name}"...`;
            statusDisplay.classList.remove('hidden');

            const masterId = await getOrCreateFolder("Organizador", "root");
            
            // Si el token expiró durante la primera comprobación
            if (masterId === 'EXPIRED') {
                statusDisplay.textContent = `⏱️ Sesión expirada (1 hora). Haz clic en "Salir" y vuelve a ingresar.`;
                return null;
            }

            const subjectId = await getOrCreateFolder(folderName, masterId);
            
            const folderRes = await fetch(`https://www.googleapis.com/drive/v3/files/${subjectId}?fields=webViewLink`, {
                headers: { 'Authorization': 'Bearer ' + accessToken }
            });
            const folderData = await folderRes.json();

            statusDisplay.textContent = `📂 Guardando en Drive: Organizador/${folderName}`;

            const metadata = { name: file.name, parents: [subjectId] };
            const formData = new FormData();
            formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            formData.append('file', file);

            const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken }, body: formData
            });

            // Manejo elegante del error 401 (Token Vencido de Google)
            if (res.status === 401) {
                statusDisplay.textContent = `⏱️ Tu sesión ha expirado por seguridad. Haz clic en "Salir" y vuelve a ingresar.`;
                return null;
            }

            if (!res.ok) throw new Error("Fallo en la conexión o subida");

            const fileData = await res.json();
            statusDisplay.textContent = `✅ Guardado con éxito.`;
            
            return { fileLink: fileData.webViewLink, folderLink: folderData.webViewLink };
        } catch (e) { 
            statusDisplay.textContent = `❌ Error de red o archivo inaccesible.`;
            console.error(e);
            return null; 
        }
    }

    async function getOrCreateFolder(name, parentId) {
        const q = encodeURIComponent(`name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        
        if (res.status === 401) return 'EXPIRED'; // Detecta expiración inmediatamente
        
        const data = await res.json();
        if (data.files && data.files.length > 0) return data.files[0].id;
        
        const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
        });
        const folder = await createRes.json();
        return folder.id;
    }

    // --- FIREBASE CRUD ---
    function loadUserTasks() {
        if (!currentUser) return;
        const q = query(tasksRef, where("userId", "==", currentUser.uid));
        unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
            tasks = [];
            snapshot.forEach(docSnap => tasks.push({ id: docSnap.id, ...docSnap.data() }));
            updateDashboard();
        });
    }

    taskForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('task-file');
        const subject = document.getElementById('task-subject').value;
        const name = document.getElementById('task-name').value;
        const date = document.getElementById('task-date').value;
        
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Procesando...';
        
        let driveData = null;

        if (fileInput.files.length > 0) {
            driveData = await uploadToDrive(fileInput.files[0], subject);
        }

        const taskData = { 
            name, subject, date, 
            fileMaterial: driveData ? driveData.fileLink : "",
            folderMaterial: driveData ? driveData.folderLink : "", 
            userId: currentUser.uid, 
            completed: false 
        };

        try {
            if (editingId) {
                // Si el token expiró y no subió el archivo nuevo, conservamos el link viejo si no hay datos nuevos
                const existingTask = tasks.find(t => t.id === editingId);
                if (!driveData && fileInput.files.length > 0) {
                    // Falló la subida, detenemos la actualización
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = 'Actualizar Tarea';
                    return; 
                } else if (!driveData && fileInput.files.length === 0) {
                    // No subió archivo nuevo, conserva el link anterior
                    taskData.fileMaterial = existingTask.fileMaterial;
                    taskData.folderMaterial = existingTask.folderMaterial;
                }
                
                await updateDoc(doc(db, "academicTasks", editingId), taskData);
                closeCurrentTaskModal();
            } else {
                if (!driveData && fileInput.files.length > 0) {
                     submitBtn.disabled = false;
                     submitBtn.innerHTML = 'Guardar Tarea';
                     return; // Falló la subida inicial, no guarda la tarea vacía
                }
                await addDoc(tasksRef, taskData);
                closeCurrentTaskModal();
            }
        } catch (err) { console.error(err); }
        
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Guardar Tarea';
        
        setTimeout(() => { statusDisplay.classList.add('hidden'); }, 4000);
    });

    // --- FILTROS Y EXPORTAR ---
    filterSubject.addEventListener('change', () => {
        selectedDateFilter = null;
        updateDashboard();
    });

    // Exportar CSV
    btnExport.addEventListener('click', () => {
        if (tasks.length === 0) return alert("No hay tareas.");
        const headers = ["Tarea", "Asignatura", "Fecha Limite", "Estado", "Link Carpeta Drive"];
        const rows = tasks.map(t => [
            t.name.replace(/,/g,""), t.subject.replace(/,/g,""), t.date, 
            t.completed ? "Completada" : "Pendiente", t.folderMaterial || "Sin carpeta"
        ].join(","));
        const csv = "\ufeff" + headers.join(",") + "\n" + rows.join("\n");
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `Organizador_UFRO_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    });

    // Exportar ICS
    btnExportIcs.addEventListener('click', () => {
        if (tasks.length === 0) return alert("No hay tareas.");
        let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Organizador Academico UFRO//ES\n";
        tasks.forEach(t => {
            if (t.completed) return; 
            const dateStr = t.date.replace(/-/g, "");
            const desc = t.folderMaterial ? `Link al material en Drive: ${t.folderMaterial}` : "Sin material adjunto";
            icsContent += "BEGIN:VEVENT\n";
            icsContent += `SUMMARY: ${t.subject} - ${t.name}\n`;
            icsContent += `DTSTART;VALUE=DATE:${dateStr}\n`;
            icsContent += `DESCRIPTION:${desc}\n`;
            icsContent += "END:VEVENT\n";
        });
        icsContent += "END:VCALENDAR";
        const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `Calendario_Entregas_UFRO_${new Date().toISOString().split('T')[0]}.ics`;
        link.click();
    });


    // --- IMPORTAR DESDE CALENDARIO (.ics) ---
    importIcsInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            const text = event.target.result;
            const events = parseICS(text);
            
            if (events.length === 0) return alert("No se encontraron eventos válidos en el archivo.");
            if (!confirm(`Se encontraron ${events.length} eventos. ¿Deseas importarlos a tu Organizador?`)) {
                importIcsInput.value = ''; 
                return;
            }

            statusDisplay.textContent = `🔄 Importando ${events.length} tareas...`;
            statusDisplay.classList.remove('hidden');

            // Subir cada evento a Firebase
            for (const ev of events) {
                const taskData = {
                    name: ev.name || "Tarea Importada",
                    subject: "Importado", // Como GCalendar no tiene asignaturas, le ponemos esta etiqueta por defecto
                    date: ev.date || new Date().toISOString().split('T')[0],
                    fileMaterial: "",
                    folderMaterial: "",
                    userId: currentUser.uid,
                    completed: false
                };
                await addDoc(tasksRef, taskData);
            }
            
            statusDisplay.textContent = `✅ Importación completada con éxito.`;
            setTimeout(() => { statusDisplay.classList.add('hidden'); }, 3000);
            importIcsInput.value = ''; // Limpiar el input
        };
        reader.readAsText(file);
    });

    // Función "Traductora" para leer archivos de calendario
    function parseICS(icsText) {
        const lines = icsText.split(/\r\n|\n|\r/);
        let events = [];
        let currentEvent = null;

        lines.forEach(line => {
            if (line.startsWith('BEGIN:VEVENT')) {
                currentEvent = {};
            } else if (line.startsWith('END:VEVENT')) {
                if (currentEvent.name && currentEvent.date) events.push(currentEvent);
                currentEvent = null;
            } else if (currentEvent) {
                if (line.startsWith('SUMMARY:')) currentEvent.name = line.substring(8).trim();
                // Busca fechas en el formato estándar de .ics (YYYYMMDD)
                if (line.startsWith('DTSTART')) {
                    const match = line.match(/(\d{4})(\d{2})(\d{2})/);
                    if (match) currentEvent.date = `${match[1]}-${match[2]}-${match[3]}`;
                }
            }
        });
        return events;
    }
  
    // --- RENDERIZADO Y DASHBOARD ---
    function updateDashboard() {
        const subjects = [...new Set(tasks.map(t => t.subject))];
        const current = filterSubject.value;
        filterSubject.innerHTML = '<option value="all">Todas</option>';
        const dl = document.getElementById('subject-list'); if(dl) dl.innerHTML = '';
        
        subjects.sort().forEach(s => {
            filterSubject.appendChild(new Option(s, s));
            if(dl) dl.appendChild(new Option(s, s));
        });
        filterSubject.value = subjects.includes(current) ? current : 'all';
        renderTasks();
        renderCalendar();
    }

    function renderTasks() {
        mainTaskList.innerHTML = ''; 
        let filtered = filterSubject.value === 'all' ? tasks : tasks.filter(t => t.subject === filterSubject.value);
        if (selectedDateFilter) filtered = filtered.filter(t => t.date === selectedDateFilter);
        
        filtered.sort((a,b) => new Date(a.date) - new Date(b.date)).forEach(t => {
            const li = document.createElement('li');
            li.className = `task-item ${t.completed ? 'completed' : ''}`;
            
            const link = t.folderMaterial || t.fileMaterial;
            
            li.innerHTML = `
                <div class="task-info">
                    <strong>${t.name}</strong><span>📚 ${t.subject} | 📅 ${t.date}</span>
                    <div class="task-material">${link ? `📂 <a href="${link}" target="_blank">Abrir Carpeta</a>` : 'Sin material'}</div>
                </div>
                <div class="task-actions">
                    <button class="btn-action" title="Completar" onclick="toggleComplete('${t.id}')">✔️</button>
                    <button class="btn-action" title="Editar" onclick="prepareEditTask('${t.id}')">✏️</button>
                    <button class="btn-action" title="Eliminar" onclick="deleteTask('${t.id}')">🗑️</button>
                </div>`;
            mainTaskList.appendChild(li);
        });
    }

    // --- FUNCIONES GLOBALES ---
    window.toggleComplete = async (id) => {
        const t = tasks.find(x => x.id === id);
        await updateDoc(doc(db, "academicTasks", id), { completed: !t.completed });
    };
    window.deleteTask = async (id) => { if(confirm("¿Eliminar esta tarea?")) await deleteDoc(doc(db, "academicTasks", id)); };
    
    window.prepareEditTask = (id) => {
        const t = tasks.find(x => x.id === id);
        openTaskModal('Editar Tarea', id);

        document.getElementById('task-name').value = t.name;
        document.getElementById('task-subject').value = t.subject;
        document.getElementById('task-date').value = t.date;
        submitBtn.innerHTML = 'Actualizar Tarea';
        cancelEditBtn.classList.remove('hidden');
    };
    function exitEditMode() { editingId = null; submitBtn.innerHTML = 'Guardar Tarea'; cancelEditBtn.classList.add('hidden'); }

    // --- CALENDARIO LÍQUIDO ---
    function renderCalendar() {
        calendarDays.innerHTML = '';
        const first = new Date(currentYear, currentMonth, 1).getDay();
        const offset = first === 0 ? 6 : first - 1;
        const days = new Date(currentYear, currentMonth + 1, 0).getDate();
        const months = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
        monthYearDisplay.textContent = `${months[currentMonth]} ${currentYear}`;
        
        for (let i = 0; i < offset; i++) calendarDays.appendChild(document.createElement('div')).className = 'calendar-day empty';
        
        for (let i = 1; i <= days; i++) {
            const d = document.createElement('div'); d.className = 'calendar-day'; d.textContent = i;
            const ds = `${currentYear}-${String(currentMonth+1).padStart(2,'0')}-${String(i).padStart(2,'0')}`;
            if (ds === new Date().toISOString().split('T')[0]) d.classList.add('today');
            if (selectedDateFilter === ds) d.classList.add('selected');
            
            d.onclick = () => { selectedDateFilter = selectedDateFilter === ds ? null : ds; updateDashboard(); };
            const dt = tasks.filter(t => t.date === ds);
            
            if (dt.length > 0) {
                const m = document.createElement('div'); m.className = 'markers-container';
                dt.slice(0,1).forEach(t => { 
                    const dot = document.createElement('div'); dot.className = `task-marker ${t.completed ? 'done' : ''}`; m.appendChild(dot); 
                });
                d.appendChild(m);
            }
            calendarDays.appendChild(d);
        }
    }

    document.getElementById('prev-month').onclick = () => { currentMonth--; if(currentMonth<0){currentMonth=11;currentYear--;} renderCalendar(); };
    document.getElementById('next-month').onclick = () => { currentMonth++; if(currentMonth>11){currentMonth=0;currentYear++;} renderCalendar(); };

    // --- TEMA (Interruptor iOS) ---
    function initTheme() {
        const themeToggleInput = document.getElementById('theme-toggle-input');
        const isDarkMode = localStorage.getItem('darkMode') === 'enabled';
        themeToggleInput.checked = isDarkMode;
        if (isDarkMode) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }

        themeToggleInput.onchange = () => {
            if (themeToggleInput.checked) {
                document.body.classList.add('dark-mode');
                localStorage.setItem('darkMode', 'enabled');
            } else {
                document.body.classList.remove('dark-mode');
                localStorage.setItem('darkMode', 'disabled');
            }
        };
    }
});
