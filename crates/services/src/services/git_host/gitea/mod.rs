use std::path::Path;

use async_trait::async_trait;
use db::models::merge::{MergeStatus, PullRequestInfo};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::info;
use url::Url;

use super::{
    GitHostProvider,
    types::{
        CreatePrRequest, GitHostError, OpenPrInfo, ProviderKind, UnifiedPrComment,
    },
};

#[derive(Debug, Clone)]
pub struct GiteaProvider {
    client: Client,
}

#[derive(Debug, Clone)]
struct GiteaRepoInfo {
    base_url: String,
    owner: String,
    repo: String,
}

#[derive(Debug, Serialize)]
struct GiteaCreatePrRequest {
    title: String,
    body: String,
    head: String,
    base: String,
}

#[derive(Debug, Deserialize)]
struct GiteaPullRequest {
    number: i64,
    html_url: String,
    state: String,
    merged: Option<bool>,
    merged_at: Option<String>,
    merge_commit_sha: Option<String>,
    head: GiteaPrBranch,
    base: GiteaPrBranch,
    title: String,
}

#[derive(Debug, Deserialize)]
struct GiteaPrBranch {
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Debug, Deserialize)]
struct GiteaComment {
    id: i64,
    body: String,
    created_at: String,
    html_url: String,
    user: GiteaUser,
}

#[derive(Debug, Deserialize)]
struct GiteaUser {
    login: String,
}

impl GiteaProvider {
    pub fn new() -> Result<Self, GitHostError> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| GitHostError::Repository(format!("Failed to create HTTP client: {e}")))?;
        Ok(Self { client })
    }

    fn parse_repo_info(remote_url: &str) -> Result<GiteaRepoInfo, GitHostError> {
        if let Ok(url) = Url::parse(remote_url) {
            let base_url = format!(
                "{}://{}{}",
                url.scheme(),
                url.host_str().unwrap_or(""),
                url.port().map(|p| format!(":{p}")).unwrap_or_default()
            );

            let path = url.path().trim_start_matches('/').trim_end_matches(".git");
            let parts: Vec<&str> = path.splitn(2, '/').collect();
            if parts.len() == 2 {
                return Ok(GiteaRepoInfo {
                    base_url,
                    owner: parts[0].to_string(),
                    repo: parts[1].to_string(),
                });
            }
        }

        if let Some(rest) = remote_url.strip_prefix("git@") {
            if let Some((host, path)) = rest.split_once(':') {
                let path = path.trim_end_matches(".git");
                let parts: Vec<&str> = path.splitn(2, '/').collect();
                if parts.len() == 2 {
                    return Ok(GiteaRepoInfo {
                        base_url: format!("http://{host}"),
                        owner: parts[0].to_string(),
                        repo: parts[1].to_string(),
                    });
                }
            }
        }

        Err(GitHostError::Repository(format!(
            "Cannot parse Gitea repository info from URL: {remote_url}"
        )))
    }

    fn parse_repo_info_from_pr_url(pr_url: &str) -> Result<(GiteaRepoInfo, i64), GitHostError> {
        let url = Url::parse(pr_url).map_err(|e| {
            GitHostError::Repository(format!("Invalid PR URL: {e}"))
        })?;

        let base_url = format!(
            "{}://{}{}",
            url.scheme(),
            url.host_str().unwrap_or(""),
            url.port().map(|p| format!(":{p}")).unwrap_or_default()
        );

        let path = url.path().trim_start_matches('/');
        let parts: Vec<&str> = path.split('/').collect();

        if parts.len() >= 4 && (parts[2] == "pulls" || parts[2] == "issues") {
            let owner = parts[0].to_string();
            let repo = parts[1].to_string();
            let pr_number: i64 = parts[3].parse().map_err(|_| {
                GitHostError::Repository(format!("Invalid PR number in URL: {pr_url}"))
            })?;
            return Ok((
                GiteaRepoInfo {
                    base_url,
                    owner,
                    repo,
                },
                pr_number,
            ));
        }

        Err(GitHostError::Repository(format!(
            "Cannot parse PR info from URL: {pr_url}"
        )))
    }

    fn api_url(info: &GiteaRepoInfo) -> String {
        format!("{}/api/v1/repos/{}/{}", info.base_url, info.owner, info.repo)
    }

    fn add_auth(
        &self,
        request: reqwest::RequestBuilder,
        info: &GiteaRepoInfo,
    ) -> reqwest::RequestBuilder {
        if let Ok(token) = std::env::var("GITEA_TOKEN") {
            return request.header("Authorization", format!("token {token}"));
        }

        if let Some((username, password)) = Self::get_git_credentials(&info.base_url) {
            return request.basic_auth(username, Some(password));
        }

        request
    }

    fn get_git_credentials(base_url: &str) -> Option<(String, String)> {
        let url = Url::parse(base_url).ok()?;
        let host = url.host_str()?;
        let protocol = url.scheme();
        let port_part = url.port().map(|p| format!("\nport={p}")).unwrap_or_default();

        let input = format!("protocol={protocol}\nhost={host}{port_part}\n\n");

        use std::io::Write;
        let mut child = std::process::Command::new("git")
            .args(["credential", "fill"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;

        child.stdin.as_mut()?.write_all(input.as_bytes()).ok()?;

        let output = child.wait_with_output().ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);

        let mut username = None;
        let mut password = None;

        for line in stdout.lines() {
            if let Some(val) = line.strip_prefix("username=") {
                username = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("password=") {
                password = Some(val.to_string());
            }
        }

        match (username, password) {
            (Some(u), Some(p)) => Some((u, p)),
            _ => None,
        }
    }

    fn map_pr_status(pr: &GiteaPullRequest) -> MergeStatus {
        if pr.merged.unwrap_or(false) {
            MergeStatus::Merged
        } else {
            match pr.state.as_str() {
                "open" => MergeStatus::Open,
                "closed" => MergeStatus::Closed,
                _ => MergeStatus::Unknown,
            }
        }
    }

    fn to_pull_request_info(pr: &GiteaPullRequest) -> PullRequestInfo {
        PullRequestInfo {
            number: pr.number,
            url: pr.html_url.clone(),
            status: Self::map_pr_status(pr),
            merged_at: pr
                .merged_at
                .as_ref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc)),
            merge_commit_sha: pr.merge_commit_sha.clone(),
        }
    }
}

#[async_trait]
impl GitHostProvider for GiteaProvider {
    async fn create_pr(
        &self,
        _repo_path: &Path,
        remote_url: &str,
        request: &CreatePrRequest,
    ) -> Result<PullRequestInfo, GitHostError> {
        let info = Self::parse_repo_info(remote_url)?;
        let api = Self::api_url(&info);

        let body = GiteaCreatePrRequest {
            title: request.title.clone(),
            body: request.body.clone().unwrap_or_default(),
            head: request.head_branch.clone(),
            base: request.base_branch.clone(),
        };

        let req = self.client.post(format!("{api}/pulls")).json(&body);
        let req = self.add_auth(req, &info);

        let response = req.send().await.map_err(|e| {
            GitHostError::PullRequest(format!("Failed to create Gitea PR: {e}"))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(GitHostError::AuthFailed(format!(
                    "Gitea auth failed ({status}): {body}"
                )));
            }
            if status.as_u16() == 404 {
                return Err(GitHostError::RepoNotFoundOrNoAccess(format!(
                    "Gitea repo not found ({status}): {body}"
                )));
            }
            return Err(GitHostError::PullRequest(format!(
                "Gitea API error ({status}): {body}"
            )));
        }

        let pr: GiteaPullRequest = response.json().await.map_err(|e| {
            GitHostError::UnexpectedOutput(format!("Failed to parse Gitea PR response: {e}"))
        })?;

        info!(
            "Created Gitea PR #{} for branch {}",
            pr.number, request.head_branch
        );

        Ok(Self::to_pull_request_info(&pr))
    }

    async fn get_pr_status(&self, pr_url: &str) -> Result<PullRequestInfo, GitHostError> {
        let (info, pr_number) = Self::parse_repo_info_from_pr_url(pr_url)?;
        let api = Self::api_url(&info);

        let req = self.client.get(format!("{api}/pulls/{pr_number}"));
        let req = self.add_auth(req, &info);

        let response = req.send().await.map_err(|e| {
            GitHostError::PullRequest(format!("Failed to get Gitea PR status: {e}"))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GitHostError::PullRequest(format!(
                "Gitea API error ({status}): {body}"
            )));
        }

        let pr: GiteaPullRequest = response.json().await.map_err(|e| {
            GitHostError::UnexpectedOutput(format!("Failed to parse Gitea PR response: {e}"))
        })?;

        Ok(Self::to_pull_request_info(&pr))
    }

    async fn list_prs_for_branch(
        &self,
        _repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<Vec<PullRequestInfo>, GitHostError> {
        let info = Self::parse_repo_info(remote_url)?;
        let api = Self::api_url(&info);

        let req = self.client.get(format!("{api}/pulls"))
            .query(&[("state", "all"), ("head", branch_name)]);
        let req = self.add_auth(req, &info);

        let response = req.send().await.map_err(|e| {
            GitHostError::PullRequest(format!("Failed to list Gitea PRs: {e}"))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GitHostError::PullRequest(format!(
                "Gitea API error ({status}): {body}"
            )));
        }

        let prs: Vec<GiteaPullRequest> = response.json().await.map_err(|e| {
            GitHostError::UnexpectedOutput(format!("Failed to parse Gitea PRs response: {e}"))
        })?;

        Ok(prs.iter().map(Self::to_pull_request_info).collect())
    }

    async fn get_pr_comments(
        &self,
        _repo_path: &Path,
        remote_url: &str,
        pr_number: i64,
    ) -> Result<Vec<UnifiedPrComment>, GitHostError> {
        let info = Self::parse_repo_info(remote_url)?;
        let api = Self::api_url(&info);

        let req = self.client.get(format!("{api}/issues/{pr_number}/comments"));
        let req = self.add_auth(req, &info);

        let response = req.send().await.map_err(|e| {
            GitHostError::PullRequest(format!("Failed to get Gitea PR comments: {e}"))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GitHostError::PullRequest(format!(
                "Gitea API error ({status}): {body}"
            )));
        }

        let comments: Vec<GiteaComment> = response.json().await.map_err(|e| {
            GitHostError::UnexpectedOutput(format!(
                "Failed to parse Gitea comments response: {e}"
            ))
        })?;

        let unified = comments
            .into_iter()
            .filter_map(|c| {
                let created_at = chrono::DateTime::parse_from_rfc3339(&c.created_at)
                    .ok()?
                    .with_timezone(&chrono::Utc);
                Some(UnifiedPrComment::General {
                    id: c.id.to_string(),
                    author: c.user.login,
                    author_association: None,
                    body: c.body,
                    created_at,
                    url: Some(c.html_url),
                })
            })
            .collect();

        Ok(unified)
    }

    async fn list_open_prs(
        &self,
        _repo_path: &Path,
        remote_url: &str,
    ) -> Result<Vec<OpenPrInfo>, GitHostError> {
        let info = Self::parse_repo_info(remote_url)?;
        let api = Self::api_url(&info);

        let req = self.client.get(format!("{api}/pulls"))
            .query(&[("state", "open"), ("limit", "50")]);
        let req = self.add_auth(req, &info);

        let response = req.send().await.map_err(|e| {
            GitHostError::PullRequest(format!("Failed to list Gitea open PRs: {e}"))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(GitHostError::PullRequest(format!(
                "Gitea API error ({status}): {body}"
            )));
        }

        let prs: Vec<GiteaPullRequest> = response.json().await.map_err(|e| {
            GitHostError::UnexpectedOutput(format!("Failed to parse Gitea PRs response: {e}"))
        })?;

        Ok(prs
            .into_iter()
            .map(|pr| OpenPrInfo {
                number: pr.number,
                url: pr.html_url,
                title: pr.title,
                head_branch: pr.head.ref_name,
                base_branch: pr.base.ref_name,
            })
            .collect())
    }

    fn provider_kind(&self) -> ProviderKind {
        ProviderKind::Gitea
    }
}
