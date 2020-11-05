import { readdirSync, readFileSync, statSync } from 'fs';
import { basename } from 'path';

import { render } from 'mustache';
import { lookup } from 'mime-types';

import { getInput, setOutput, setFailed, info, warning } from '@actions/core';
import { create } from '@actions/artifact';
import { getOctokit, context } from '@actions/github';
import { exec, ExecOptions } from '@actions/exec';

/*

IDEA:

GitHub Action that:
- takes inputs for handlebars variables and template path, title string
- checks if current build is tagged
- creates release from mustache/handlebars template
- downloads all artifacts
- //uploads all artifacts that end in ['.deb', '.rpm', '.exe', '.msi', '.pkg.tar.zst', '.apk', '.appx', '.AppImage', '.snap'] to release
- uploads all artifacts beginning with release_ to release
- outputs release url

*/

async function run() {
	try {
		// Get current tag
		let tag: string = "";
		let tagError: string = "";

		const options: ExecOptions = {
			listeners: {
				stdout: (data: Buffer) => {
					tag += data.toString();
				},
				stderr: (data: Buffer) => {
					tagError += data.toString();
				}
			}
		};

		// Fetch tags because GitHub doesn't
		await exec('git', ['fetch', '-t', '--depth=1']);
		await exec('git', ['tag', '--points-at', context.sha], options);

		// Exit if current build is not tagged
		if (tagError) {
			setFailed("Getting tag failed: " + tagError);
		}
		if (!tag) {
			info("No tag found");
			return;
		}

		info("Using tag " + tag);

		// Get authenticated GitHub client (Ocktokit): https://github.com/actions/toolkit/tree/master/packages/github#usage
		const github = getOctokit(getInput('token', {required: true}));

		let template = null;
		try {
			template = readFileSync(getInput('template', { required: true }), { encoding: 'utf8' });
		} catch (error) {
			setFailed(error.message);
		}

		let body = render(template, JSON.parse(getInput("variables") || "{}"));

		info("Rendered body");

		// Create a release
		// API Documentation: https://developer.github.com/v3/repos/releases/#create-a-release
		// Octokit Documentation: https://octokit.github.io/rest.js/#octokit-routes-repos-create-release
		const createReleaseResponse = await github.repos.createRelease({
			owner: context.repo.owner,
			repo: context.repo.repo,
			tag_name: tag,
			name: getInput('title', { required: true }),
			body: body,
			draft: getInput('draft', { required: false }) === 'true',
			prerelease: getInput('prerelease', { required: false }) === 'true',
			target_commitish: context.sha
		});

		info(`Created release ${createReleaseResponse.data.name}`);

		// Get the ID, html_url, and upload URL for the created Release from the response
		const {
			data: { id: releaseID, html_url: htmlURL, upload_url: uploadURL }
		} = createReleaseResponse;

		// Set the output variables for use by other actions: https://github.com/actions/toolkit/tree/master/packages/core#inputsoutputs
		setOutput('id', releaseID);
		setOutput('url', htmlURL);

		info("Downloading artifacts");

		const artifactClient = create();
		const downloadResponse = await artifactClient.downloadAllArtifacts();

		// Upload all artifacts to release
		for (const response of downloadResponse) {
			if (!response.artifactName.startsWith("release_")) {
				continue;
			}

			const files = readdirSync(response.downloadPath);

			for(const path of files) {
				const fileName = basename(path);
				const fileSize = statSync(path).size;

				info(`Uploading ${fileName}.`);

				github.repos.uploadReleaseAsset({
					owner: context.repo.owner,
					repo: context.repo.repo,
					release_id: releaseID,
					name: fileName,
					data: readFileSync(path)
				}).catch((err) => {
					warning(`Failed to upload ${fileName}: ` + err.message);
				});
			}
			
		}
	} catch (error) {
		setFailed(error.message);
	}
}

run();