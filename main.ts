import { statSync, readFileSync } from 'fs';
import { basename, extname } from 'path';

import { render } from 'mustache';
import { lookup } from 'mime-types';

import { getInput, setOutput, setFailed, info, debug, warning } from '@actions/core';
import { create } from '@actions/artifact';
import { getOctokit, context } from '@actions/github';

/*

IDEA:

GitHub Action that:
- takes inputs for handlebars variables and template path, title string
- checks if current build is tagged
- creates release from mustache/handlebars template
- downloads all artifacts
- uploads all artifacts that end in ['.deb', '.rpm', '.exe', '.msi', '.pkg.tar.zst', '.apk', '.appx', '.AppImage', '.snap'] to release
- outputs release url

*/

const fileTypes = ['.deb', '.rpm', '.exe', '.msi', '.pkg.tar.zst', '.apk', '.appx', '.AppImage', '.snap'];

async function run() {
	try {
		// Exit if current build is not tagged
		if (!context.ref.startsWith("refs/tags/")) {
			return;
		}

		// Get authenticated GitHub client (Ocktokit): https://github.com/actions/toolkit/tree/master/packages/github#usage
		const github = getOctokit(process.env.GITHUB_TOKEN);

		let template = null;
		try {
			template = readFileSync(getInput('template', { required: true }), { encoding: 'utf8' });
		} catch (error) {
			setFailed(error.message);
		}
		let body = render(template, process.env);

		info("Rendered body");

		// Create a release
		// API Documentation: https://developer.github.com/v3/repos/releases/#create-a-release
		// Octokit Documentation: https://octokit.github.io/rest.js/#octokit-routes-repos-create-release
		const createReleaseResponse = await github.repos.createRelease({
			owner: context.repo.owner,
			repo: context.repo.repo,
			tag_name: context.ref.replace('refs/tags/', ''),
			name: getInput('title', { required: true }),
			body: body,
			draft: getInput('draft', { required: false }) === 'true',
			prerelease: getInput('prerelease', { required: false }) === 'true',
			target_commitish: context.sha
		});

		info(`Created release with code ${createReleaseResponse.status}`);

		// Get the ID, html_url, and upload URL for the created Release from the response
		const {
			data: { id: releaseId, html_url: htmlUrl, upload_url: uploadUrl }
		} = createReleaseResponse;

		// Set the output variables for use by other actions: https://github.com/actions/toolkit/tree/master/packages/core#inputsoutputs
		setOutput('id', releaseId);
		setOutput('url', htmlUrl);

		const artifactClient = create();
		const downloadResponse = await artifactClient.downloadAllArtifacts();

		// Upload all artifacts to release
		for (const response of downloadResponse) {
			const fileName = basename(response.downloadPath);
			const fileExt = extname(response.downloadPath);
			if (fileTypes.indexOf(fileExt) == -1) {
				debug(`Ignoring ${fileName} because it is of type ${fileExt}.`);
				continue;
			} else {
				info(`Uploading ${fileName}.`);
			}
			try {
				const uploadAssetResponse = await github.repos.uploadReleaseAsset({
					owner: context.repo.owner,
					repo: context.repo.repo,
					release_id: releaseId,
					data: "",
					url: uploadUrl,
					headers: { 'Content-Type': lookup(fileExt) || 'application/octet-stream', 'Content-Length': statSync(response.downloadPath).size },
					name: fileName,
					file: readFileSync(response.downloadPath)
				});
			} catch (error) {
				warning(`Failed to upload ${fileName}: ` + error.message);
			}
		}
	} catch (error) {
		setFailed(error.message);
	}
}

run();