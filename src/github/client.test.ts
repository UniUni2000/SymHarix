import { describe, it, expect, beforeEach } from 'bun:test';
import { GitHubClient } from './client';

describe('GitHubClient', () => {
  let client: GitHubClient;

  beforeEach(() => {
    client = new GitHubClient({
      token: 'ghp_test_token',
      owner: 'test-owner'
    });
  });

  it('should create instance with correct owner', () => {
    expect((client as any).owner).toBe('test-owner');
  });

  it('should have repoExists method', () => {
    expect(typeof client.repoExists).toBe('function');
  });

  it('should have createRepo method', () => {
    expect(typeof client.createRepo).toBe('function');
  });

  it('should have getDefaultBranch method', () => {
    expect(typeof client.getDefaultBranch).toBe('function');
  });
});