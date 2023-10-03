const { execSync } = require('child_process');
const { stripIndents } = require('common-tags');
const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const packageJSON = require('./package.json');

function getGithubCommentInput() {
  const input = core.getInput('github-comment');
  if (input === 'true') return true;
  if (input === 'false') return false;
  return input;
}

const { context } = github;

const githubToken = core.getInput('github-token');
const githubComment = getGithubCommentInput();
const workingDirectory = core.getInput('working-directory');
const prNumberRegExp = /{{\s*PR_NUMBER\s*}}/g;
const branchRegExp = /{{\s*BRANCH\s*}}/g;

function isPullRequestType(event) {
  return event.startsWith('pull_request');
}

function slugify(str) {
  const slug = str
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  core.debug(`before slugify: "${str}"; after slugify: "${slug}"`);
  return slug;
}

function retry(fn, retries) {
  async function attempt(retryCount) {
    try {
      return await fn();
    } catch (error) {
      if (retryCount > retries) {
        throw error;
      } else {
        core.info(`retrying: attempt ${retryCount + 1} / ${retries + 1}`);
        await new Promise((resolve) => {
          setTimeout(resolve, 3000);
        });
        return attempt(retryCount + 1);
      }
    }
  }
  return attempt(1);
}

// Vercel
function getVercelBin() {
  const input = core.getInput('vercel-version');
  const fallback = packageJSON.dependencies.vercel;
  return `vercel@${input || fallback}`;
}

const vercelToken = core.getInput('vercel-token', { required: true });
const vercelArgs = core.getInput('vercel-args');
const vercelBuildArgs = core.getInput('vercel-build-args');
const vercelPrebuild = core.getBooleanInput('prebuild');
const vercelArchive = core.getBooleanInput('archive');
const vercelOrgId = core.getInput('vercel-org-id');
const vercelProjectId = core.getInput('vercel-project-id');
const vercelScope = core.getInput('scope');
const vercelProjectName = core.getInput('vercel-project-name');
const vercelBin = getVercelBin();
const aliasDomains = core
  .getInput('alias-domains')
  .split('\n')
  .filter((x) => x !== '')
  .map((s) => {
    let url = s;
    let branch = slugify(context.ref.replace('refs/heads/', ''));
    if (isPullRequestType(context.eventName)) {
      const pr =
        context.payload.pull_request || context.payload.pull_request_target;
      branch = slugify(pr.head.ref.replace('refs/heads/', ''));
      url = url.replace(prNumberRegExp, context.issue.number.toString());
    }
    url = url.replace(branchRegExp, branch);

    return url;
  });

/** @type {ReturnType<typeof github.getOctokit>} */
let octokit;
if (githubToken) {
  octokit = github.getOctokit(githubToken);
}

async function setEnv() {
  core.info('set environment for vercel cli');
  if (vercelOrgId) {
    core.info('set env variable : VERCEL_ORG_ID');
    core.exportVariable('VERCEL_ORG_ID', vercelOrgId);
  }
  if (vercelProjectId) {
    core.info('set env variable : VERCEL_PROJECT_ID');
    core.exportVariable('VERCEL_PROJECT_ID', vercelProjectId);
  }
}

function addVercelMetadata(key, value, providedArgs) {
  // returns a list for the metadata commands if key was not supplied by user in action parameters
  // returns an empty list if key was provided by user
  const pattern = `^${key}=.+`;
  const metadataRegex = new RegExp(pattern, 'g');
  // eslint-disable-next-line no-restricted-syntax
  for (const arg of providedArgs) {
    if (arg.match(metadataRegex)) {
      return [];
    }
  }

  return ['-m', `${key}=${value}`];
}

async function vercelDeploy(ref, commit) {
  let myOutput = '';
  // eslint-disable-next-line no-unused-vars
  let myError = '';
  const options = {
    listeners: {
      stdout: (data) => {
        myOutput += data.toString();
        core.debug(data.toString());
      },
      stderr: (data) => {
        // eslint-disable-next-line no-unused-vars
        myError += data.toString();
        core.debug(data.toString());
      },
    },
  };
  if (workingDirectory) {
    options.cwd = workingDirectory;
  }

  const providedArgs = vercelArgs.split(/ +/);
  const providedBuildArgs = vercelBuildArgs.split(/ +/).reduce((acc, arg) => {
    const [key, value] = arg.split('=');
    return { ...acc, [key]: value };
  }, {});

  const argsBase = ['--yes', ...['-t', vercelToken]];

  const args = [
    ...providedArgs,
    ...argsBase,
    ...addVercelMetadata('githubCommitSha', context.sha, providedArgs),
    ...addVercelMetadata('githubCommitAuthorName', context.actor, providedArgs),
    ...addVercelMetadata(
      'githubCommitAuthorLogin',
      context.actor,
      providedArgs,
    ),
    ...addVercelMetadata('githubDeployment', 1, providedArgs),
    ...addVercelMetadata('githubOrg', context.repo.owner, providedArgs),
    ...addVercelMetadata('githubRepo', context.repo.repo, providedArgs),
    ...addVercelMetadata('githubCommitOrg', context.repo.owner, providedArgs),
    ...addVercelMetadata('githubCommitRepo', context.repo.repo, providedArgs),
    ...addVercelMetadata('githubCommitMessage', `"${commit}"`, providedArgs),
    ...addVercelMetadata(
      'githubCommitRef',
      ref.replace('refs/heads/', ''),
      providedArgs,
    ),
  ];

  if (vercelScope) {
    core.info('using scope');
    args.push('--scope', vercelScope);
  }

  if (vercelPrebuild) {
    await exec.exec(
      'npx',
      [
        vercelBin,
        'build',
        ...argsBase,
        ...(providedArgs.includes('--prod') ? ['--prod'] : []),
      ],
      {
        env: {
          ...process.env,
          ...providedBuildArgs,
        },
        ...(workingDirectory ? { cwd: workingDirectory } : null),
      },
    );
    core.info('prebuilt');
    args.push('--prebuilt');

    if (vercelArchive) {
      core.info('archive');
      args.push('--archive=tgz');
    }
  }

  options.env = {...(options.env || {}), ...providedBuildArgs};
  await exec.exec('npx', [vercelBin, ...args], options);

  return myOutput;
}

async function vercelInspect(deploymentUrl) {
  // eslint-disable-next-line no-unused-vars
  let myOutput = '';
  let myError = '';
  const options = {};
  options.listeners = {
    stdout: (data) => {
      // eslint-disable-next-line no-unused-vars
      myOutput += data.toString();
      core.debug(data.toString());
    },
    stderr: (data) => {
      myError += data.toString();
      core.debug(data.toString());
    },
  };
  if (workingDirectory) {
    options.cwd = workingDirectory;
  }

  const args = [vercelBin, 'inspect', deploymentUrl, '-t', vercelToken];

  if (vercelScope) {
    core.info('using scope');
    args.push('--scope', vercelScope);
  }
  await exec.exec('npx', args, options);

  const match = myError.match(/^\s+name\s+(.+)$/m);
  return match && match.length ? match[1] : null;
}

async function findCommentsForEvent() {
  core.debug('find comments for event');
  /** @type {Awaited<ReturnType<typeof octokit.rest.repos.listCommentsForCommit>>['data']} */
  let comments = [];
  if (context.eventName === 'push') {
    core.debug('event is "commit", use "listCommentsForCommit"');
    const { data } = await octokit.rest.repos.listCommentsForCommit({
      ...context.repo,
      commit_sha: context.sha,
    });
    comments = data;
  } else if (isPullRequestType(context.eventName)) {
    core.debug(`event is "${context.eventName}", use "listComments"`);
    const { data } = await octokit.rest.issues.listComments({
      ...context.repo,
      issue_number: context.issue.number,
    });
    comments = data;
  } else {
    core.error('not supported event_type');
  }
  return comments;
}

async function findPreviousComment(text) {
  if (!octokit) {
    return null;
  }
  core.info('find comment');
  const comments = await findCommentsForEvent();

  const vercelPreviewURLComment = comments.find((comment) =>
    comment.body.startsWith(text),
  );
  if (vercelPreviewURLComment) {
    core.info('previous comment found');
    return vercelPreviewURLComment.id;
  }
  core.info('previous comment not found');
  return null;
}

function joinDeploymentUrls(deploymentUrl, aliasDomains_) {
  if (aliasDomains_.length) {
    const aliasUrls = aliasDomains_.map((domain) => `https://${domain}`);
    return [deploymentUrl, ...aliasUrls].join('\n');
  }
  return deploymentUrl;
}

function buildCommentPrefix(deploymentName) {
  return `Deploy preview for _${deploymentName}_ ready!`;
}

function buildCommentBody(deploymentCommit, deploymentUrl, deploymentName) {
  if (!githubComment) {
    return undefined;
  }
  const prefix = `${buildCommentPrefix(deploymentName)}\n\n`;

  const rawGithubComment =
    prefix +
    (typeof githubComment === 'string'
      ? githubComment
      : stripIndents`
      ✅ Preview
      {{deploymentUrl}}

      Built with commit {{deploymentCommit}}.
      This pull request is being automatically deployed with [vercel-action](https://github.com/marketplace/actions/vercel-action)
    `);

  return rawGithubComment
    .replace(/\{\{deploymentCommit\}\}/g, deploymentCommit)
    .replace(/\{\{deploymentName\}\}/g, deploymentName)
    .replace(
      /\{\{deploymentUrl\}\}/g,
      joinDeploymentUrls(deploymentUrl, aliasDomains),
    );
}

async function createCommentOnCommit(
  deploymentCommit,
  deploymentUrl,
  deploymentName,
) {
  if (!octokit) {
    return;
  }
  const commentId = await findPreviousComment(
    buildCommentPrefix(deploymentName),
  );

  const commentBody = buildCommentBody(
    deploymentCommit,
    deploymentUrl,
    deploymentName,
  );

  if (commentId) {
    await octokit.rest.repos.updateCommitComment({
      ...context.repo,
      comment_id: commentId,
      body: commentBody,
    });
  } else {
    await octokit.rest.repos.createCommitComment({
      ...context.repo,
      commit_sha: context.sha,
      body: commentBody,
    });
  }
}

async function createCommentOnPullRequest(
  deploymentCommit,
  deploymentUrl,
  deploymentName,
) {
  if (!octokit) {
    return;
  }
  const commentId = await findPreviousComment(
    `Deploy preview for _${deploymentName}_ ready!`,
  );

  const commentBody = buildCommentBody(
    deploymentCommit,
    deploymentUrl,
    deploymentName,
  );

  if (commentId) {
    await octokit.rest.issues.updateComment({
      ...context.repo,
      comment_id: commentId,
      body: commentBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: context.issue.number,
      body: commentBody,
    });
  }
}

async function aliasDomainsToDeployment(deploymentUrl) {
  if (!deploymentUrl) {
    core.error('deployment url is null');
  }
  const args = ['-t', vercelToken];
  if (vercelScope) {
    core.info('using scope');
    args.push('--scope', vercelScope);
  }
  const promises = aliasDomains.map((domain) =>
    retry(
      () =>
        exec.exec('npx', [vercelBin, ...args, 'alias', deploymentUrl, domain]),
      2,
    ),
  );

  await Promise.all(promises);
}

async function run() {
  core.debug(`action : ${context.action}`);
  core.debug(`ref : ${context.ref}`);
  core.debug(`eventName : ${context.eventName}`);
  core.debug(`actor : ${context.actor}`);
  core.debug(`sha : ${context.sha}`);
  core.debug(`workflow : ${context.workflow}`);
  let { ref } = context;
  let { sha } = context;
  await setEnv();

  let commit = execSync('git log -1 --pretty=format:%B').toString().trim();
  if (github.context.eventName === 'push') {
    const pushPayload = github.context.payload;
    core.debug(`The head commit is: ${pushPayload.head_commit}`);
  } else if (isPullRequestType(github.context.eventName)) {
    const pullRequestPayload = github.context.payload;
    const pr =
      pullRequestPayload.pull_request || pullRequestPayload.pull_request_target;
    core.debug(`head : ${pr.head}`);

    ref = pr.head.ref;
    sha = pr.head.sha;
    core.debug(`The head ref is: ${pr.head.ref}`);
    core.debug(`The head sha is: ${pr.head.sha}`);

    if (octokit) {
      const { data: commitData } = await octokit.rest.git.getCommit({
        ...context.repo,
        commit_sha: sha,
      });
      commit = commitData.message;
      core.debug(`The head commit is: ${commit}`);
    }
  }

  const deploymentUrl = await vercelDeploy(ref, commit);

  if (deploymentUrl) {
    core.info('set preview-url output');
    if (aliasDomains && aliasDomains.length) {
      core.info('set preview-url output as first alias');
      core.setOutput('preview-url', `https://${aliasDomains[0]}`);
    } else {
      core.setOutput('preview-url', deploymentUrl);
    }
  } else {
    core.warning('get preview-url error');
  }

  const deploymentName =
    vercelProjectName || (await vercelInspect(deploymentUrl));
  if (deploymentName) {
    core.info('set preview-name output');
    core.setOutput('preview-name', deploymentName);
  } else {
    core.warning('get preview-name error');
  }

  if (aliasDomains.length) {
    core.info('alias domains to this deployment');
    await aliasDomainsToDeployment(deploymentUrl);
  }

  if (githubComment && githubToken) {
    if (context.issue.number) {
      core.info('this is related issue or pull_request');
      await createCommentOnPullRequest(sha, deploymentUrl, deploymentName);
    } else if (context.eventName === 'push') {
      core.info('this is push event');
      await createCommentOnCommit(sha, deploymentUrl, deploymentName);
    }
  } else {
    core.info('comment : disabled');
  }
}

run().catch((error) => {
  core.setFailed(error.message);
});
