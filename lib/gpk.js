/*!
 * Copyright (c) 2019, Braydon Fuller
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const util = require('util');
const fs = require('fs');
const child_process = require('child_process');
const path = require('path');
const semver = require('../vendor/semver');
const readFile = util.promisify(fs.readFile);
const access = util.promisify(fs.access);
const {execFile, spawn} = child_process;
const {cloneRepo, verifyRepo, listTags} = require('./git');

const NODE_GYP = path.resolve(__dirname, '../vendor/node-gyp/bin/node-gyp.js');

function expandSrc(root, remotes, name, src) {
  const git = [];
  const matched = src.match(/^(git\+(ssh\:\/\/|https\:\/\/)|git\:\/\/)(.*)$/);

  function findVersion(branch) {
    let version = null;

    if (branch)
      version = branch.replace('semver:', '');

    if (version !== branch)
      branch = null;
    else
      version = null;

    return {branch, version};
  }

  // Handle sources.
  if (matched) {
    const protocol = matched[1];
    let url = null;

    if (matched[2])
      url = matched[2] + matched[3];
    else
      url = matched[1] + matched[3];

    let [host, extra] = url.split('#');
    const {branch, version} = findVersion(extra);

    git.push(host);

    return {git, version, branch};
  }

  // Handle version only sources.
  if (!remotes)
    return {git, version: src, branch: null};

  // Handle multiple remote sources.
  const [remote, id] = src.split(/\:(.*)/, 2);
  let [repo, extra] = id.split('#');
  const {branch, version} = findVersion(extra);

  if (!repo)
    repo = name;

  const hosts = remotes[remote];

  if (!hosts)
    throw new Error(`Unknown remote ${remote}.`);

  if (!Array.isArray(hosts))
    throw new Error('Remotes expected to be an array.')

  for (const host of hosts) {
    if (host.indexOf('file:') === 0) {
      let dir = host.replace('file:', '');

      if (!path.isAbsolute(dir))
        dir = path.resolve(root, dir)

      git.push(`${dir}/${repo}/.git`);
    } else {
      git.push(`${host}/${repo}.git`);
    }
  }


  return {git, version, branch};
}

function matchTag(tags, needed) {
  let matched = null;

  // Filter out all tags that are not version tags.
  const filtered = tags.filter(tag => tag.indexOf('v') === 0);

  // Sort lexicographical with the largest value at the beginning.
  const sorted = filtered.sort((a, b) => {
    if (a == b)
      return 0;
    else
      return a < b ? 1 : -1;
  });

  for (const tag of sorted) {
    // Remove the leading 'v' version in the tag.
    const version = tag.replace('v', '');
    if (semver.satisfies(version, needed)) {
      matched = tag;
      break;
    }
  }

  return matched;
}

async function locatePkg(dst, walk = true) {
  let cwd = dst;
  let data = null;

  while (cwd != null && data == null) {
    try {
      data = await readFile(path.join(cwd, './package.json'), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT')
        throw err;

      const parent = path.resolve(cwd, '../');
      if (parent === cwd || !walk)
        cwd = null;
      else
        cwd = parent
    }
  }

  let pkg = null;

  if (data)
    pkg = JSON.parse(data)

  return {root: cwd, pkg};
}

async function run(dst, name) {
  const {root, pkg} = await locatePkg(dst);

  if (!pkg.scripts || !pkg.scripts[name])
    throw new Error(`Unknown script '${name}'.`);

  const [cmd, ...args] = pkg.scripts[name].split(' ');

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {cwd: root, stdio: 'inherit'});
    child.on('close', code => resolve(code));
    child.on('exit', code => resolve(code));
    child.on('error', err => reject(err));
  });
}

async function rebuild(dst) {
  return new Promise((resolve, reject) => {
    execFile(NODE_GYP, ['rebuild'], {cwd: dst}, (err, stdout) => {
      if (err)
        reject(err);
      resolve(stdout);
    });
  });
}

async function install(dst, prefix = null, options = {}) {
  const {root, pkg} = await locatePkg(dst, false);

  if (prefix == null)
    prefix = root;

  if (!pkg)
    throw new Error('Unknown package.');

  if (!pkg.dependencies)
    return;

  const installed = [];

  const dependencies = pkg.dependencies;

  if (!options.production && pkg.devDependencies) {
    for (const [name, src] of Object.entries(pkg.devDependencies)) {
      if (!dependencies[name])
        dependencies[name] = src;
    }
  }

  for (const [name, src] of Object.entries(dependencies)) {
    const {git, version} = expandSrc(prefix, pkg.remotes, name, src);

    // Prefer to install dependency as flat as possible.
    let dst = path.join(prefix, `./node_modules/${name}`);
    let existingPkg = null;

    try {
      existingPkg = JSON.parse(
        await readFile(path.join(dst, './package.json'), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT')
        throw err;
    }

    if (existingPkg) {
      if (semver.satisfies(existingPkg.version, version))
        continue;

      // There is an incompatible existing version, so it's
      // necessary to install relative to the module.
      dst = path.join(root, `./node_modules/${name}`);
    }

    if (git.length === 0)
      throw new Error(`Unknown remotes for '${name}'.`);

    for (const url of git) {
      const tags = await listTags(url);
      const tag = matchTag(Object.keys(tags), version);

      if (!tag)
        continue;

      const {annotated, commit} = tags[tag];

      let success = await cloneRepo(tag, url, dst);

      try {
        if (annotated)
          success = await verifyRepo(tag, null, dst);
        else
          success = await verifyRepo(null, commit, dst);
      } catch (err) {
        throw new Error(`Could not verify ${dst}, reason: ${err.message}.`);
      }

      if (success) {
        installed.push(dst);
        break;
      }
    }
  }

  // Install each of the dependencies.
  for (const nextDst of installed)
    await install(nextDst, prefix);

  // Check if native addon should be built.
  const gyp = path.join(root, './binding.gyp');
  let addon = false;
  try {
    await access(gyp, fs.constants.R_OK);
    addon = true
  } catch (err) {
    if (err.code !== 'ENOENT')
      throw err;
  }

  if (addon)
    await rebuild(root)
}

module.exports = {
  expandSrc,
  matchTag,
  locatePkg,
  rebuild,
  install,
  run
}