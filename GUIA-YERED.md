# Guía de inicio para Yered

Con **mp** vas a ver en tu pantalla lo que Bruno está programando en ese momento, aunque todavía no lo haya guardado en el proyecto. Él te ve a ti igual. Solo hay que instalarlo una vez.

> Esta guía es para macOS. mp todavía no se ha probado en Mac: si algo no sale como dice aquí, no es tu culpa. Avísale a Bruno (al final dice cómo).

## Palabras que vas a ver

- **Terminal:** una ventana donde escribes órdenes en vez de hacer clic.
- **Repo:** la carpeta de un proyecto, con todo su historial de cambios.
- **Commit:** un "guardado" oficial en ese historial.
- **Remoto:** la copia del repo que vive en internet (en GitHub). Por ahí se comparte el trabajo.

## 1. Abre la Terminal

Pulsa **Cmd + Espacio**, escribe `Terminal` y pulsa **Enter**.

Para escribir una orden: la tecleas (o la pegas con Cmd + V) y pulsas Enter.

## 2. Revisa que tienes lo necesario

Escribe estas dos órdenes, una por una:

```bash
git --version
```

```bash
node --version
```

Cada una debe responder con un número. `node` tiene que decir `v20` o más.

Si alguna dice "command not found", te falta ese programa. **No sigas todavía:** avísale a Bruno para instalarlo juntos.

## 3. Instala mp (solo una vez)

Descarga mp y entra a su carpeta:

```bash
git clone https://github.com/devv-jr/code-multiplayer.git
```

```bash
cd code-multiplayer
```

`cd` significa "entrar a una carpeta". Ahora instálalo con estas tres órdenes; espera a que termine cada una antes de la siguiente (la primera tarda un par de minutos):

```bash
npm install
```

```bash
npm run build
```

```bash
npm link
```

Comprueba que quedó instalado:

```bash
mp --version
```

Debe responder `0.1.0`.

**Si `npm link` falla con un error que dice `EACCES` o "permission denied":** no uses `sudo`. Avísale a Bruno; se arregla instalando Node de otra forma.

## 4. Entra al proyecto que comparten

mp se usa **dentro de la carpeta del proyecto en el que trabajan los dos**, no dentro de la carpeta de mp. Por ejemplo, si el proyecto está en tu Escritorio y se llama `mi-proyecto`:

```bash
cd ~/Desktop/mi-proyecto
```

Truco: escribe `cd ` (con un espacio al final), arrastra la carpeta desde Finder hasta la Terminal y pulsa Enter.

## 5. Los tres comandos que importan

### `mp doctor`: ¿está todo bien?

```bash
mp doctor
```

Revisa todo y te lo dice con marcas: **✓** está bien, **⚠** es un aviso (puedes seguir) y **✗** hay que arreglarlo. Debajo de cada ✗ dice por qué pasó y qué hacer.

### `mp up`: empezar a trabajar

```bash
mp up
```

La primera vez te pregunta un nombre para mostrarte: escribe `yered`. Después se abre una página en tu navegador, **la sala**, donde aparecen Bruno y tú, y los archivos que cada quien está tocando.

Deja esa Terminal abierta mientras trabajas. Programa como siempre, en tu editor.

### `mp who`: ver quién está, sin abrir la página

```bash
mp who
```

Para usarlo mientras `mp up` está corriendo, abre otra ventana de Terminal (Cmd + N) y entra otra vez a la carpeta del proyecto.

## 6. Cuando termines

En la Terminal donde corre `mp up`, pulsa **Ctrl + C**. Dirá `mp detenido.`

- **Si cierras la Terminal, mp también se detiene.** No pasa nada malo: tu trabajo sigue en tu carpeta. Bruno simplemente deja de ver tus cambios nuevos.
- Para volver a empezar: entra a la carpeta del proyecto y escribe `mp up`.

mp **nunca cambia tus archivos**. Solo los mira.

## 7. Si la sala dice "Tu subida está en pausa"

mp encontró un archivo que parece tener contraseñas o claves (por ejemplo, uno llamado `.env`) y se detuvo para no compartirlo por accidente. Es una protección, no un error.

La misma sala te dice qué línea agregar a un archivo llamado `.gitignore`, que es la lista de archivos que no se comparten. Ábrelo con tu editor, agrega esa línea en un renglón nuevo y guarda. mp sigue solo, sin reiniciar nada.

Si no estás seguro, pregúntale a Bruno antes de hacer nada.

## 8. Si algo falla

1. Entra a la carpeta del proyecto y escribe `mp doctor`.
2. Copia **todo** lo que salió en la Terminal (selecciónalo con el ratón y pulsa Cmd + C).
3. Mándaselo a Bruno, junto con lo que estabas intentando hacer.

Con eso casi siempre basta para saber qué pasó.
