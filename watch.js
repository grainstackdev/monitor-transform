#!/usr/bin/env node

import minimist from 'minimist'
import watch from 'watch'
import c from 'ansi-colors'
import {spawn} from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import micromatch from 'micromatch'

const argv = minimist(process.argv.slice(2))
const help = argv['h'] || argv['help']

if (help) {
  console.log(`Usage:
    monitor --watch <glob> [--transform <glob>] [--using <file.js>] --output <dir> --exec <string>
    
Example:
    monitor --watch src --transform 'src/*/src/**/*.{js,mjs}' --using transformer.js --output build --exec 'echo "server started"'
 
Options:
    --watch -w        A glob. All watched files go to the output, but some are transformed along the way. At least one required.
    --transform -t    Files matching this glob are passed through the transformer. Optional.
    --using -u        The transformer. A JS file which has at least \`default export (inputPath, outputPath, contents) => {return contents}\`. Optional.
    --output -o       The output directory. Required.
    --exec -e         The command to exec after rebuild. Required.
    --debug -d        Log statements about node_modules are excluded by default.`)
} else {
  const w = argv['w'] || argv['watch']
  const watchDirs = Array.isArray(w) ? w : [w]
  const outDir = argv['output'] || argv['o']
  const transformGlob = argv['transform'] || argv['t']
  const transformer = argv['using'] || argv['u']
  const command = argv['exec'] || argv['e']
  const debug = argv['d'] || argv['debug']

  if (watchDirs.length === 0) {
    throw new Error('At least one --watch (-w) option must be specified. -w is a directory to watch.')
  }

  if (!outDir && !Array.isArray(outDir)) {
    throw new Error('A single --output (-o) option should be specified. -o is the output directory.')
  }

  if (Array.isArray(transformGlob)) {
    throw new Error('Only one --transform (-t) option can be specified. -t is a glob specifying which files should be passed through the transformer.')
  }

  if (Array.isArray(transformer)) {
    throw new Error('Only one --using (-u) option must be specified. -u is a JS file with a default export (fpath, contents) => {return contents}.')
  }

  const transform = transformer ? (await import(path.resolve(transformer))).default : (fpath, contents) => {return contents}

  fs.removeSync(outDir)
  fs.ensureDirSync(outDir)

  let execTimeout
  let child

  process.on("SIGINT", () => {
    console.log(`${c.green('[monitor]')} ${c.red('stopped')}`)
    if (child) {
      child.kill('SIGINT')
      child.kill('SIGTERM')
      child.kill('SIGKILL')
      process.kill(-child.pid)
      process.exit()
    }
  })

  function queueExec() {
    if (execTimeout) {
      clearTimeout(execTimeout)
      execTimeout = null
    }
    if (child) {
      console.log(`${c.green('[monitor]')} ${c.yellow('restarting...')}`)
      child.kill('SIGINT')
      child.kill('SIGTERM')
      child.kill('SIGKILL')
      process.kill(-child.pid)
      child = null
    }
    execTimeout = setTimeout(() => {
      // console.log('pipe eerr')
      console.log(`${c.green('[monitor]')} ${c.grey(command)}`)
      child = spawn(command.split(' ')[0], command.split(' ').slice(1), {
        stdio: ['pipe', process.stdout, process.stderr],
        detached: true
      })
      // child.stdout.on('data', (data) => {
      //   console.log(data.toString())
      // })
    }, 100)
  }

  function getOutDirPath(filepath) {
    const split = filepath.split(/(?:\/|\\)/)
    return path.resolve(outDir, split.slice(1).join('/'))
  }

  function pass(f) {
    const isNodeModule = f.includes('node_modules/')
    const originalPath = path.resolve(f)
    const filepath = getOutDirPath(f)
    const shortFilepath = path.relative(process.cwd(), filepath)
    const isDir = fs.lstatSync(originalPath).isDirectory()
    const shouldTransform = transformGlob ? micromatch.isMatch(f, transformGlob) : false
    const shouldLog = debug || (!isNodeModule && !isDir)
    if (isDir) {
      if (!fs.existsSync(filepath)) {
        fs.ensureDirSync(filepath)
        if (shouldLog) {
          console.log(`${c.green('[monitor]')} ${c.grey(`ensured dir ${shortFilepath}`)}`)
        }
      }
    } else if (shouldTransform) {
      if (shouldLog) {
        console.log(`${c.green('[monitor]')} ${c.grey(`${c.blueBright('transpiling')} ${f}`)}`)
      }
      const contents = fs.readFileSync(originalPath, {encoding: 'utf8'})
      const newContents = transform(originalPath, filepath, contents)
      fs.writeFileSync(filepath, newContents, {encoding: "utf-8"})
      queueExec()
    } else {
      fs.copySync(originalPath, filepath)
      if (shouldLog) {
        console.log(`${c.green('[monitor]')} ${c.grey(`${c.blue('copied')} ${f}`)}`)
      }
      queueExec()
    }
  }

  for (const dir of watchDirs) {
    // Tell it what to watch
    console.log(`${c.green('[monitor]')} ${c.grey(`${c.yellow('watching')} ${dir}`)}`)
    watch.watchTree(dir, {interval: 0.1}, (f, curr, prev) => {
      if (typeof f == "object" && prev === null && curr === null) {
        // Finished walking the tree on startup
        // Move all files into outDir
        for (const key of Object.keys(f)) {
          pass(key)
        }
      } else {
        const isNew = prev === null
        const isRemoved = curr.nlink === 0
        const isChanged = !isNew && !isRemoved
        if (isNew || isChanged) {
          // pass through transform
          // place in outDir
          pass(f)
        } else if (isRemoved) {
          // remove from outDir
          const filepath = getOutDirPath(f)
          fs.removeSync(filepath)
          const shortFilepath = path.relative(process.cwd(), filepath)
          if (prev.nlink === 2) {
            if (debug) {
              console.log(`${c.green('[monitor]')} ${c.grey(`removed dir ${shortFilepath}`)}`)
            }
          } else {
            console.log(`${c.green('[monitor]')} ${c.grey(`${c.red('removed')} ${shortFilepath}`)}`)
            queueExec()
          }
        }
      }
    })
  }
}
