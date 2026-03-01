import {
  HttpClientTestingModule,
  HttpTestingController
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { DataService } from './data.service';

describe('DataService (agent)', () => {
  let dataService: DataService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule]
    });

    dataService = TestBed.inject(DataService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('posts chat requests to the agent proxy endpoint', () => {
    const body = {
      message: 'Hello',
      conversationHistory: [{ role: 'user', content: 'Hi' }]
    };

    dataService.postAgentChat(body).subscribe();

    const req = httpMock.expectOne('/api/v1/agent/chat');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(body);
    req.flush({ answer: 'Hi there', confidence: 0.9, warnings: [] });
  });
});
